import { SteeringAttachments } from './steering-attachments'
import { SteeringService } from './steering'
import { createConsultAgent } from './steering-agent'
import { registerSteeringIpc } from './steering-ipc'
import { trustExistingRun } from './trust-ipc'
import { createRunAttachments } from './run-attachments'
import { registerAttachmentIpc } from './attachment-ipc'
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import fixPath from 'fix-path'
import type { AccountRotation, AccountsResult, AccountsState, HarnessAction, HarnessKind } from '../shared/harness'
import { IPC } from '../shared/ipc'
import { type CritiqueRound, type LoopLogLine, type LoopRecord, type ReferenceStudy } from '../shared/loop'
import { isCodexModel, resolveModels } from '../shared/models'
import { REPORT_FILE_SUFFIX, type DeleteRunsResult, type ReportRecord, type ReportRunRow } from '../shared/reports'
import { referencePackDir, referenceRootForLoop } from '../shared/reference-path'
import { failure, success, type OperationResult } from '../shared/result'
import { redactedErrorMessage } from '../shared/redact-log'
import {
  accountDir,
  addAccount,
  clearCooldown,
  earliestReset,
  isAccountId,
  isCooling,
  labelAccount,
  markLimited,
  parseResetAt,
  PRIMARY_ACCOUNT_ID,
  readAccounts,
  removeAccount,
  switchAccount,
} from './accounts'
import { subscriptionEnv, cliHome, harnessesRoot } from './harness-env'
import { HarnessLoginManager } from './harness-login'
import { subscriptionAuthError } from './harness-status'
import {
  assertHarnessKind,
  assertLoopId,
  parseLogLimit,
  parseDeleteRunsInput,
  parseLoopListOffset,
  parseOnboardingHarness,
  parseOptionalRound,
  parseRunPageOffset,
  parseRunPromptRequest,
  parseRenameInput,
  parseStartLoopInput,
  parseTerminalInput,
  parseTerminalResize,
  renameTrustError,
} from './ipc-input'
import { Ledger } from './ledger'
import { OnboardingStore } from './onboarding'
import { LoopRunner } from './loop-runner'
import { stopExistingLoop } from './loop-stop'
import { MediaBaseGate, startMediaServer } from './media-server'
import { hasActivePlay, playAccessError, playState, startPlay, stopAllPlayAndWait, stopPlay } from './play'
import { parseReadStreamInput, rawStreamTrustError, readRawStreamChunk, resolveProtectedRawStreamPath } from './raw-streams'
import { scanReferencePack } from './reference-pack'
import { buildReport, scanCritiqueArtifacts } from './report'
import { buildReportRow, parseReportFile, renderReportMarkdown, reportFileBase, toReportFile } from './reports'
import { checkoutRoundRevision, configureRoundRevisionStorage } from './round-revision'
import {
  copyRunFolder,
  deleteRunFolder,
  exportActivityError,
  nextAvailableExportPath,
  RAW_EXPORT_WARNING,
  RUN_LEDGER_FILE,
  RUN_METADATA_DIR,
  safeExportFolderName,
} from './run-transfer'
import { developmentRendererUrl } from './dev-renderer-url'
import { developmentAppIconPath } from './development-app-icon'
import { assertWorkspaceBoundary, captureWorkspaceIdentity } from './workspace-boundary'
import { boundedLoopSnapshot, loopListPage } from './ipc-projection'
import { withPromptLogs, type PromptLogRun } from './prompt-logs'
import { settleQuitSupervisors } from './quit-settlement'
import { readExactFileDescriptor } from './bounded-fd'
import { resolveUserDataOverride } from './user-data-dir'
import { configureAgentWritableRoots } from './cli-executable'

let mainWindow: BrowserWindow | null = null
let ledger: Ledger | null = null
let steering: SteeringService | null = null
let loopRunner: LoopRunner | null = null
let mediaGate: MediaBaseGate | null = null

const APP_NAME = 'Gauntlet Gamesmith'
const developmentInstance = !app.isPackaged && /^[a-z0-9-]{1,40}$/.test(process.env.GAUNTLET_INSTANCE_ID ?? '') ? process.env.GAUNTLET_INSTANCE_ID : null
const LEGACY_APP_NAME = 'Gauntlet Loop'
const smokeTestMode = process.argv.includes('--gauntlet-smoke-test')
const MAX_REPORT_IMPORT_BYTES = 8 * 1024 * 1024

function readBoundedReportFile(filePath: string): string {
  const descriptor = fsSync.openSync(filePath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fsSync.fstatSync(descriptor)
    const linked = fsSync.lstatSync(filePath)
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || !linked.isFile()
      || linked.isSymbolicLink()
      || linked.nlink !== 1
      || linked.dev !== opened.dev
      || linked.ino !== opened.ino
    ) throw new Error('The selected report is not a unique regular file.')
    const bytes = readExactFileDescriptor(descriptor, opened.size, MAX_REPORT_IMPORT_BYTES, 'Report import')
    const after = fsSync.fstatSync(descriptor)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 || after.size !== opened.size) {
      throw new Error('The selected report changed while it was being read.')
    }
    return bytes.toString('utf8')
  } finally {
    fsSync.closeSync(descriptor)
  }
}

function resolveUserData(): string {
  const appData = app.getPath('appData')
  const current = path.join(appData, APP_NAME)
  const legacy = path.join(appData, LEGACY_APP_NAME)
  if (fsSync.existsSync(current) || !fsSync.existsSync(legacy)) return current
  try {
    fsSync.renameSync(legacy, current)
    return current
  } catch {
    return legacy
  }
}

function protectedWorkspaceRoots(): string[] {
  return [app.getPath('userData'), cliHome('claude'), cliHome('codex')]
}

/** Where new runs are created when the user has not chosen a folder. */
function defaultWorkspaceParent(): string {
  return path.join(app.getPath('home'), 'GauntletGames')
}

/**
 * Directories an agent can write into: the app's own private state, the folder
 * new runs are created in, and every project folder a run has used. Executable
 * resolution refuses to spawn anything found inside them.
 */
configureAgentWritableRoots(() => [
  ...protectedWorkspaceRoots(),
  defaultWorkspaceParent(),
  ...(ledger?.workspaceRoots() ?? []),
])

app.setName(APP_NAME)
app.setPath('userData', smokeTestMode && process.env.GAUNTLET_SMOKE_USER_DATA
  ? process.env.GAUNTLET_SMOKE_USER_DATA
  : resolveUserDataOverride(process.argv) ?? (developmentInstance ? path.join(app.getPath('appData'), `${APP_NAME} Dev ${developmentInstance}`) : resolveUserData()))
if (developmentInstance) fsSync.mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 })
fixPath()
configureRoundRevisionStorage(path.join(app.getPath('userData'), 'round-revisions'))

const harnessLogins = new HarnessLoginManager(app.getPath('home'), {
  action: (kind, action) => {
    recordSuccessfulLogin(kind, action)
    mainWindow?.webContents.send(IPC.harness.loginEvent, { kind, action })
  },
  terminal: (kind, data) => mainWindow?.webContents.send(IPC.harness.terminalData, { kind, data }),
})

let onboardingStore: OnboardingStore | null = null

function onboarding(): OnboardingStore {
  onboardingStore ??= new OnboardingStore(app.getPath('userData'))
  return onboardingStore
}

function recordSuccessfulLogin(kind: HarnessKind, action: HarnessAction): void {
  if (action.type !== 'probe_finished' || !action.loggedIn) return
  const root = harnessesRoot()
  const state = readAccounts(root, kind)
  clearCooldown(root, kind, state.activeId)
  const email = action.details?.find(([label]) => label === 'Email')?.[1]
  if (email) labelAccount(root, kind, state.activeId, email)
}

async function rotateAccount(kind: HarnessKind, error = ''): Promise<AccountRotation> {
  const root = harnessesRoot()
  const before = readAccounts(root, kind)
  const from = before.accounts.find((account) => account.id === before.activeId)?.label ?? before.activeId
  markLimited(root, kind, before.activeId, parseResetAt(error) ?? undefined)
  const state = readAccounts(root, kind)
  for (const candidate of state.accounts) {
    if (candidate.id === state.activeId || isCooling(candidate)) continue
    const status = await harnessLogins.probe(kind, accountDir(root, kind, candidate.id))
    if (!status.loggedIn) continue
    switchAccount(root, kind, candidate.id)
    mainWindow?.webContents.send(IPC.harness.accountsChanged, kind)
    return { ok: true, from, to: candidate.label }
  }
  mainWindow?.webContents.send(IPC.harness.accountsChanged, kind)
  const others = state.accounts.filter((account) => account.id !== state.activeId)
  return {
    ok: false,
    from,
    resetAt: others.length > 0 ? (earliestReset(state) ?? undefined) : undefined,
    reason: others.length === 0
      ? 'no other account is set up'
      : 'every other account is signed out or inside its own limit window',
  }
}

function accountChange(kind: HarnessKind, change: () => AccountsState): AccountsResult {
  const root = harnessesRoot()
  if (ledger?.runningLoop()) {
    return { ok: false, state: readAccounts(root, kind), error: 'Stop the running loop before switching accounts.' }
  }
  harnessLogins.cancel(kind)
  return { ok: true, state: change() }
}

async function forgetAccount(kind: HarnessKind, accountId: string): Promise<AccountsResult> {
  const root = harnessesRoot()
  if (accountId === PRIMARY_ACCOUNT_ID) {
    return {
      ok: false,
      state: readAccounts(root, kind),
      error: 'Account 1 holds the shared session history. Sign out of it instead of removing it.',
    }
  }
  if (ledger?.runningLoop()) {
    return { ok: false, state: readAccounts(root, kind), error: 'Stop the running loop before removing an account.' }
  }
  harnessLogins.cancel(kind)
  await harnessLogins.logout(kind, accountDir(root, kind, accountId))
  return { ok: true, state: removeAccount(root, kind, accountId) }
}

function registerLoopIpc(): void {
  ipcMain.handle(IPC.loop.start, async (_event, value: unknown) => {
    if (!loopRunner) return { ok: false, error: 'Loop runner not ready.' }
    try {
      const input = parseStartLoopInput(value)
      const models = resolveModels(input, input, input, input)
      const picks = [models.orchestratorModel, models.subagentModel, models.criticModel, models.researchModel, models.assetModel]
      const needsCodex = picks.some(isCodexModel)
      const needsClaude = picks.some((model) => model != null && !isCodexModel(model))
      const [claudeStatus, codexStatus] = await Promise.all([
        needsClaude ? harnessLogins.probe('claude') : Promise.resolve(null),
        needsCodex ? harnessLogins.probe('codex') : Promise.resolve(null),
      ])
      const claudeError = needsClaude ? subscriptionAuthError('Claude Code', claudeStatus) : null
      if (claudeError) return { ok: false, error: claudeError }
      const codexError = needsCodex ? subscriptionAuthError('Codex', codexStatus) : null
      if (codexError) return { ok: false, error: codexError }
      return loopRunner.start({ ...input, ...models }, 'new-child')
    } catch (error) {
      return { ok: false, error: redactedErrorMessage(error, 'Invalid loop input.') }
    }
  })
  ipcMain.handle(IPC.loop.trust, (_event, value: unknown) => {
    if (!ledger) return failure('Run history is not ready.')
    return trustExistingRun(ledger, value,
      (options) => mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options),
      (loop, line) => {
        mainWindow?.webContents.send(IPC.loop.log, line)
        const projection = ledger?.recentRunProjectionForLoop(loop.id, 200)
        if (projection) mainWindow?.webContents.send(IPC.loop.update, boundedLoopSnapshot({ loop, runs: projection.runs, totalRuns: ledger!.runCount(loop.id), detailTruncated: projection.truncatedFields, aggregate: ledger!.runAggregate(loop.id) }))
      }, hasActivePlay)
  })
  ipcMain.handle(IPC.loop.resume, (_event, value: unknown) => {
    try {
      return loopRunner?.resumeLoop(assertLoopId(value)) ?? { ok: false, error: 'Loop runner not ready.' }
    } catch (error) {
      return { ok: false, error: redactedErrorMessage(error, 'Invalid loop id.') }
    }
  })
  ipcMain.handle(IPC.loop.stop, (_event, value: unknown) => {
    try {
      if (!loopRunner || !ledger) return failure('Loop runner is not ready.')
      return stopExistingLoop(ledger, loopRunner, assertLoopId(value))
    } catch (error) {
      return failure(redactedErrorMessage(error, 'Invalid loop id.'))
    }
  })
  ipcMain.handle(IPC.loop.list, (_event, offsetValue: unknown) => {
    const offset = parseLoopListOffset(offsetValue)
    return ledger
      ? loopListPage(ledger.recentLoops(100, offset), ledger.loopCount(), offset, (loopId) => ledger!.runCount(loopId))
      : { snapshots: [], total: 0, offset, hasMore: false }
  })
  ipcMain.handle(IPC.loop.get, (_event, value: unknown, offsetValue: unknown) => {
    const loop = ledger?.getLoop(assertLoopId(value))
    if (!loop || !ledger) return null
    const runOffset = parseRunPageOffset(offsetValue)
    const projection = ledger.recentRunProjectionForLoop(loop.id, 200, runOffset)
    return boundedLoopSnapshot({ loop, runs: projection.runs, totalRuns: ledger.runCount(loop.id), runOffset, detailTruncated: projection.truncatedFields, aggregate: ledger.runAggregate(loop.id) })
  })
  ipcMain.handle(IPC.loop.rename, (_event, loopId: unknown, value: unknown) => {
    try {
      if (!ledger) return failure('Run history is not ready.')
      const input = parseRenameInput(loopId, value)
      const loop = ledger.getLoop(input.loopId)
      if (!loop) return failure('Run not found.')
      const trustError = renameTrustError(loop.playTrusted)
      if (trustError) return failure(trustError)
      ledger.patchLoop(input.loopId, { title: input.title })
      const updated = ledger.getLoop(input.loopId)
      return updated ? success(updated) : failure('Run disappeared while renaming.')
    } catch (error) {
      return failure(redactedErrorMessage(error, 'Could not rename run.'))
    }
  })
  ipcMain.handle(IPC.loop.deleteRuns, async (_event, value: unknown, deleteFilesValue: unknown): Promise<DeleteRunsResult> => {
    if (!ledger) return { ok: false, deletedIds: [], errors: ['Run storage is not ready.'] }
    try {
      const input = parseDeleteRunsInput(value, deleteFilesValue)
      const deletedIds: string[] = []
      const errors: string[] = []
      for (const loopId of input.loopIds) {
        const loop = ledger.getLoop(loopId)
        if (!loop) {
          errors.push('One of the runs was already gone.')
          continue
        }
        if (loop.status === 'running') {
          errors.push(`"${loop.title}" is still running. Stop it first.`)
          continue
        }
        const sharing = input.deleteFiles
          ? ledger.loopsInWorkspace(loop.workspaceDir).filter((other) => other.id !== loopId)
          : []
        if (sharing.length > 0) {
          errors.push(`"${loop.title}" shares its project folder with ${sharing.length} other ${sharing.length === 1 ? 'run' : 'runs'}, so the files were kept.`)
        }
        try {
          if (input.deleteFiles && sharing.length === 0) {
            ledger.assertLoopWorkspaceIdentity(loopId)
            await deleteRunFolder(loop.workspaceDir, app.getPath('home'))
          }
          ledger.deleteLoop(loopId)
          deletedIds.push(loopId)
        } catch (error) {
          errors.push(`Could not delete "${loop.title}": ${redactedErrorMessage(error, 'Deletion failed safely.')}`)
        }
      }
      return { ok: errors.length === 0, deletedIds, errors }
    } catch (error) {
      return { ok: false, deletedIds: [], errors: [redactedErrorMessage(error, 'Invalid run deletion request.')] }
    }
  })
  ipcMain.handle(IPC.loop.active, () => {
    if (!ledger) return null
    const loop = ledger.runningLoop() ?? ledger.latestLoop()
    if (!loop) return null
    const projection = ledger.recentRunProjectionForLoop(loop.id, 200)
    return boundedLoopSnapshot({ loop, runs: projection.runs, totalRuns: ledger.runCount(loop.id), detailTruncated: projection.truncatedFields, aggregate: ledger.runAggregate(loop.id) })
  })
  ipcMain.handle(IPC.loop.log, (_event, loopId: unknown, limit: unknown) => {
    if (!ledger) return []
    const id = assertLoopId(loopId)
    const events = ledger.eventsForLoop(id, parseLogLimit(limit))
    const represented = [...new Set(events.slice().reverse().flatMap((event) => event.runId ? [event.runId] : []))].slice(0, 64).reverse()
    const runs = represented
      .map((runId) => ledger!.promptRunForLog(runId))
      .filter((run): run is PromptLogRun => run != null && run.loopId === id)
    const latest = runs.length === 0 ? ledger.latestPromptRunForLog(id) : null
    return withPromptLogs(latest ? [latest] : runs, events)
  })
  ipcMain.handle(IPC.loop.prompt, (_event, loopId: unknown, role: unknown, round: unknown) => {
    try {
      if (!ledger) return failure('Run history is not ready.')
      const input = parseRunPromptRequest(loopId, role, round)
      if (!ledger.getLoop(input.loopId)) return failure('Run not found.')
      const prompt = ledger.runPrompt(input.loopId, input.role, input.round)
      return prompt ? success(prompt) : failure(`No ${input.role} prompt was recorded for round ${input.round}.`)
    } catch (error) {
      return failure(redactedErrorMessage(error, 'Could not load the exact prompt.'))
    }
  })
  ipcMain.handle(IPC.loop.readStream, (_event, value: unknown) => {
    try {
      if (!ledger) return failure('Raw streams are not ready.')
      const input = parseReadStreamInput(value)
      const run = ledger.getRun(input.runId)
      if (!run) return failure('Run not found.')
      if (input.stream === 'agent' && !run.metrics?.agents.some((agent) => agent.id === input.agentId)) {
        return failure('Agent stream does not belong to this run.')
      }
      const loop = ledger.getLoop(run.loopId)
      if (!loop) return failure('Run owner not found.')
      const trustError = rawStreamTrustError(loop.playTrusted)
      if (trustError) return failure(trustError)
      const workspaceDir = ledger.assertLoopWorkspaceIdentity(loop.id)
      const latestImplementRunId = ledger.latestRunIdForRole(loop.id, 'implement')
      const streamPath = resolveProtectedRawStreamPath(
        {
          workspaceDir,
          runId: run.id,
          sessionId: run.sessionId,
          claudeHome: cliHome('claude'),
          codexHome: cliHome('codex'),
          allowLiveChildStream: latestImplementRunId === run.id,
        },
        input,
        protectedWorkspaceRoots(),
      )
      return success(readRawStreamChunk(streamPath, input.offset, input.identity))
    } catch (error) {
      return failure(redactedErrorMessage(error, 'Could not read raw stream.'))
    }
  })
  ipcMain.handle(IPC.loop.report, (_event, value: unknown) => {
    try {
      if (!ledger) return failure('Run history is not ready.')
      const loop = ledger.getLoop(assertLoopId(value))
      if (!loop) return failure('Run not found.')
      ledger!.assertLoopWorkspaceIdentity(loop.id)
      const totalRuns = ledger.runCount(loop.id)
      const runs = ledger.recentRunProjectionForLoop(loop.id, 500).runs
      const referenceDir = referenceRootForLoop(loop.id, ledger.hasRunRole(loop.id, 'reference'))
      return success(buildReport(
        loop,
        runs,
        scanCritiqueArtifacts(loop.workspaceDir, loop),
        scanReferencePack(loop.workspaceDir, referenceDir, loop),
        { totalRuns, aggregate: ledger.runAggregate(loop.id) },
      ))
    } catch (error) {
      return failure(redactedErrorMessage(error, 'Could not build report.'))
    }
  })
  ipcMain.handle(IPC.loop.exportRun, async (_event, value: unknown) => {
    try {
      if (!mainWindow || !ledger) return { ok: false, error: 'Run export is not ready.' }
      const loop = ledger.getLoop(assertLoopId(value))
      if (!loop) return { ok: false, error: 'Run not found.' }
      ledger.assertLoopWorkspaceIdentity(loop.id)
      const activityError = exportActivityError(ledger.hasRunningActivity(), hasActivePlay())
      if (activityError) return { ok: false, error: activityError }
      if (ledger.hasRunErrorPrefixForWorkspace(loop.workspaceDir, 'Launch identity was not durably recorded before the app exited.')) {
        return { ok: false, error: 'This workspace is quarantined after unknown process ownership and cannot be exported while an untracked writer may survive.' }
      }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Export complete run folder',
        message: `${RAW_EXPORT_WARNING} Choose where ${APP_NAME} should copy the complete project and its exact SQLite history.`,
        buttonLabel: 'Export here',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory'],
      })
      const parentDir = result.filePaths[0]
      if (result.canceled || !parentDir) return { ok: false, canceled: true }
      const changedActivityError = exportActivityError(ledger.hasRunningActivity(), hasActivePlay())
      if (changedActivityError) return { ok: false, error: changedActivityError }
      if (ledger.hasRunErrorPrefixForWorkspace(loop.workspaceDir, 'Launch identity was not durably recorded before the app exited.')) {
        return { ok: false, error: 'This workspace is quarantined after unknown process ownership and cannot be exported while an untracked writer may survive.' }
      }
      assertWorkspaceBoundary(parentDir, protectedWorkspaceRoots())
      const sourceDir = ledger.prepareRunFolder(loop.id)
      const destinationDir = nextAvailableExportPath(parentDir, safeExportFolderName(path.basename(sourceDir)))
      await copyRunFolder(sourceDir, destinationDir, loop.workspaceIdentity)
      return { ok: true, filePath: destinationDir, warning: RAW_EXPORT_WARNING }
    } catch (error) {
      return { ok: false, error: `Could not export run: ${redactedErrorMessage(error, 'Unknown export failure.')}` }
    }
  })
  ipcMain.handle(IPC.loop.importRun, async () => {
    try {
      if (!mainWindow || !ledger) return { ok: false, error: 'Run import is not ready.' }
      const pickedExport = await dialog.showOpenDialog(mainWindow, {
        title: 'Open exported run folder',
        message: `Choose the transferred project folder containing ${RUN_METADATA_DIR}/${RUN_LEDGER_FILE}.`,
        buttonLabel: 'Open run folder',
        properties: ['openDirectory'],
      })
      const workspaceDir = pickedExport.filePaths[0]
      if (pickedExport.canceled || !workspaceDir) return { ok: false, canceled: true }
      assertWorkspaceBoundary(workspaceDir, protectedWorkspaceRoots())
      const snapshots = ledger.importRunFolder(workspaceDir)
      const primary = snapshots[0]
        ? boundedLoopSnapshot({ ...snapshots[0], aggregate: ledger.runAggregate(snapshots[0].loop.id) })
        : undefined
      return {
        ok: true,
        snapshot: primary,
        snapshots: primary ? [primary] : [],
      }
    } catch (error) {
      return { ok: false, error: `Could not import run: ${redactedErrorMessage(error, 'Unknown import failure.')}` }
    }
  })
  ipcMain.handle(IPC.media.base, async (): Promise<OperationResult<string>> =>
    mediaGate ? await mediaGate.get() : failure('Media server has not started yet.'))
  ipcMain.handle(IPC.loop.critique, (_event, value: unknown) => {
    try {
      if (!ledger) return failure('Run history is not ready.')
      const loop = ledger.getLoop(assertLoopId(value))
      if (!loop) return failure('Run not found.')
      ledger.assertLoopWorkspaceIdentity(loop.id)
      const artifacts = new Map(scanCritiqueArtifacts(loop.workspaceDir, loop).map((artifact) => [artifact.round, artifact]))
      const byRound = new Map<number, CritiqueRound>()
      const totalCritiques = ledger.runCountByRole(loop.id, 'critique')
      const critiqueProjection = ledger.latestRunProjectionPerRound(loop.id, 'critique', 100)
      const critiqueRuns = critiqueProjection.runs
      let remainingThoughtBytes = 512 * 1024
      for (const run of boundedLoopSnapshot({ loop, runs: critiqueRuns, totalRuns: totalCritiques }).runs) {
        const artifact = artifacts.get(run.round)
        const thoughtRows = ledger.eventsForRun(run.id, 'thought', 50)
        const thoughts: string[] = []
        let thoughtTruncated = thoughtRows.length === 50
        for (const line of thoughtRows) {
          const text = line.text.replace(/^𝜓\s*/, '').slice(0, 16 * 1024)
          const size = Buffer.byteLength(text, 'utf8')
          if (size > remainingThoughtBytes) {
            thoughtTruncated = true
            break
          }
          remainingThoughtBytes -= size
          thoughts.push(text)
        }
        byRound.set(run.round, {
          round: run.round,
          runId: run.id,
          status: run.status,
          verdict: run.verdict,
          thoughts,
          shots: artifact?.shots ?? [],
          refs: artifact?.refs ?? [],
          videos: artifact?.videos ?? [],
          pairs: artifact?.pairs ?? null,
          pairsMd: artifact?.pairsMd ?? null,
          truncated: (artifact?.truncated ?? false) || thoughtTruncated || totalCritiques > critiqueRuns.length || critiqueProjection.truncatedFields,
        })
      }
      return success([...byRound.values()].sort((a, b) => a.round - b.round))
    } catch (error) {
      return failure(redactedErrorMessage(error, 'Could not load critique details.'))
    }
  })
  ipcMain.handle(IPC.loop.reference, (_event, loopValue: unknown, runValue: unknown): ReferenceStudy | null => {
    if (!ledger) return null
    const loop = ledger.getLoop(assertLoopId(loopValue))
    const run = runValue == null ? ledger.latestRunForLoopByRole(loop?.id ?? '', 'reference') : ledger.getRun(assertLoopId(runValue))
    if (!loop || !run || run.loopId !== loop.id || run.role !== 'reference') return null
    try {
      ledger.assertLoopWorkspaceIdentity(loop.id)
    } catch {
      return null
    }
    return {
      runId: run.id,
      status: run.status,
      prompt: run.prompt,
      logs: withPromptLogs([run], ledger.eventsForRun(run.id, undefined, 500)),
      pack: scanReferencePack(loop.workspaceDir, referencePackDir(loop.id), loop),
    }
  })
  ipcMain.handle(IPC.play.start, (_event, value: unknown, roundValue: unknown) => {
    const loop = ledger?.getLoop(assertLoopId(value))
    if (!loop) return { running: false, url: null, error: 'Loop not found.', round: null }
    const accessError = playAccessError(loop)
    if (accessError) {
      return {
        running: false,
        url: null,
        error: accessError,
        round: null,
      }
    }
    try {
      ledger!.assertLoopWorkspaceIdentity(loop.id)
    } catch (error) {
      return { running: false, url: null, error: redactedErrorMessage(error, 'The workspace path is unsafe.'), round: null }
    }
    const round = parseOptionalRound(roundValue)
    const revision = round == null
      ? null
      : ledger?.succeededImplementRevision(loop.id, round)
    if (round != null && !revision) {
      return {
        ...playState(loop.id),
        error: `Round ${round} has no saved Git revision. Revisions are available for rounds completed after this feature was installed.`,
      }
    }
    try {
      const playDir = revision ? checkoutRoundRevision(loop.workspaceDir, loop.id, round!, revision) : loop.workspaceDir
      const expectedWorkspace = revision
        ? captureWorkspaceIdentity(playDir, protectedWorkspaceRoots())
        : loop
      return startPlay(
        loop.id,
        playDir,
        round,
        revision ? playDir : null,
        (state) => mainWindow?.webContents.send(IPC.play.state, state),
        {},
        { expectedWorkspace, protectedRoots: protectedWorkspaceRoots() },
      )
    } catch (error) {
      return {
        ...playState(loop.id),
        error: `Could not check out round ${round}: ${redactedErrorMessage(error, 'Unknown checkout failure.')}`,
      }
    }
  })
  ipcMain.handle(IPC.play.stop, (_event, value: unknown) => {
    const loopId = assertLoopId(value)
    stopPlay(loopId)
  })
  ipcMain.handle(IPC.play.state, (_event, value: unknown) => playState(assertLoopId(value)))
  ipcMain.handle(IPC.loop.pickWorkspace, async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where new run folders are created',
      buttonLabel: 'Use for new runs',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.loop.defaultWorkspace, () => defaultWorkspaceParent())
}

function registerIpc(): void {
  ipcMain.handle(IPC.onboarding.get, () => onboarding().read())
  ipcMain.handle(IPC.onboarding.complete, (_event, value: unknown) =>
    onboarding().complete(parseOnboardingHarness(value)))
  ipcMain.handle(IPC.onboarding.reset, () => onboarding().reset())
  ipcMain.handle(IPC.harness.detect, (_event, value: unknown) => harnessLogins.detect(assertHarnessKind(value)))
  ipcMain.handle(IPC.harness.probe, (_event, value: unknown) => harnessLogins.probe(assertHarnessKind(value)))
  ipcMain.handle(IPC.harness.installOffer, (_event, value: unknown) => harnessLogins.offerInstall(assertHarnessKind(value)))
  ipcMain.handle(IPC.harness.startInstall, (_event, value: unknown) => harnessLogins.install(assertHarnessKind(value)))
  ipcMain.handle(IPC.harness.startLogin, (_event, value: unknown) => harnessLogins.start(assertHarnessKind(value)))
  ipcMain.handle(IPC.harness.cancelLogin, (_event, value: unknown) => harnessLogins.cancel(assertHarnessKind(value)))
  ipcMain.handle(IPC.harness.logout, async (_event, value: unknown) => {
    const kind = assertHarnessKind(value)
    if (ledger?.runningLoop()) return { ok: false, error: 'Stop the running loop before signing out.' }
    return await harnessLogins.logout(kind)
  })
  ipcMain.handle(IPC.harness.accounts, (_event, value: unknown) =>
    readAccounts(harnessesRoot(), assertHarnessKind(value)))
  ipcMain.handle(IPC.harness.addAccount, (_event, value: unknown) => {
    const kind = assertHarnessKind(value)
    return accountChange(kind, () => addAccount(harnessesRoot(), kind))
  })
  ipcMain.handle(IPC.harness.switchAccount, (_event, value: unknown, accountValue: unknown) => {
    const kind = assertHarnessKind(value)
    if (!isAccountId(accountValue)) throw new Error('Unknown account.')
    return accountChange(kind, () => switchAccount(harnessesRoot(), kind, accountValue))
  })
  ipcMain.handle(IPC.harness.removeAccount, (_event, value: unknown, accountValue: unknown) => {
    const kind = assertHarnessKind(value)
    if (!isAccountId(accountValue)) throw new Error('Unknown account.')
    return forgetAccount(kind, accountValue)
  })
  ipcMain.on(IPC.harness.terminalInput, (_event, value: unknown) => {
    try {
      const input = parseTerminalInput(value)
      harnessLogins.write(input.kind, input.data)
    } catch {
      // Fire-and-forget terminal data is rejected at the trust seam.
    }
  })
  ipcMain.on(IPC.harness.terminalResize, (_event, value: unknown) => {
    try {
      const input = parseTerminalResize(value)
      harnessLogins.resize(input.kind, input.cols, input.rows)
    } catch {
      // Fire-and-forget terminal data is rejected at the trust seam.
    }
  })
}

function createWindow(): BrowserWindow {
  const appIcon = developmentAppIconPath(app.getAppPath(), app.isPackaged)
  const window = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: developmentInstance ? `${APP_NAME} — ${developmentInstance}` : APP_NAME,
    backgroundColor: '#100d0e',
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.on('closed', () => {
    harnessLogins.stopAll()
    mainWindow = null
  })

  const developmentUrl = developmentRendererUrl(process.env.ELECTRON_RENDERER_URL, app.isPackaged)
  if (developmentUrl) {
    void window.loadURL(developmentUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return window
}

function reportIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error('Report run ids must be an array of at most 1000 ids.')
  return [...new Set(value.map(assertLoopId))]
}

function reportName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Report name must be a string.')
  const name = value.trim()
  if (!name || name.length > 80) throw new Error('Report name must be between 1 and 80 characters.')
  return name
}

function reportRowsFor(loopIds: readonly string[]): ReportRunRow[] {
  if (!ledger) return []
  const store = ledger
  return loopIds
    .map((id) => store.getLoop(id))
    .filter((loop): loop is LoopRecord => loop != null)
    .map((loop) => buildReportRow({ loop, runs: store.runsForLoop(loop.id) }))
}

function touchReport(report: ReportRecord, patch: Partial<ReportRecord>): ReportRecord {
  return ledger!.saveReport({ ...report, ...patch, updatedAt: new Date().toISOString() })
}

async function saveReportFile(report: ReportRecord, extension: string, body: string, title: string): Promise<unknown> {
  if (!mainWindow) return { ok: false, error: 'Report export is not ready.' }
  const result = await dialog.showSaveDialog(mainWindow, {
    title,
    defaultPath: path.join(app.getPath('downloads'), `${reportFileBase(report.name)}${extension}`),
    buttonLabel: 'Save report',
  })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  await fs.writeFile(result.filePath, body, 'utf8')
  return { ok: true, filePath: result.filePath }
}

function registerReportIpc(): void {
  ipcMain.handle(IPC.report.list, () => ledger?.reports() ?? [])
  ipcMain.handle(IPC.report.get, (_event, value: unknown) => ledger?.getReport(assertLoopId(value)) ?? null)
  ipcMain.handle(IPC.report.create, (_event, nameValue: unknown, value: unknown) => {
    if (!ledger) return null
    const stamp = new Date().toISOString()
    return ledger.saveReport({
      id: crypto.randomUUID(),
      name: reportName(nameValue),
      createdAt: stamp,
      updatedAt: stamp,
      capturedAt: stamp,
      rows: reportRowsFor(reportIds(value)),
    })
  })
  ipcMain.handle(IPC.report.rename, (_event, reportId: unknown, value: unknown) => {
    const report = ledger?.getReport(assertLoopId(reportId))
    return report ? touchReport(report, { name: reportName(value) }) : null
  })
  ipcMain.handle(IPC.report.addRuns, (_event, reportId: unknown, value: unknown) => {
    const report = ledger?.getReport(assertLoopId(reportId))
    if (!report) return null
    const present = new Set(report.rows.map((row) => row.loopId))
    const ids = reportIds(value).filter((id) => !present.has(id))
    return ids.length > 0 ? touchReport(report, { rows: [...report.rows, ...reportRowsFor(ids)] }) : report
  })
  ipcMain.handle(IPC.report.removeRuns, (_event, reportId: unknown, value: unknown) => {
    const report = ledger?.getReport(assertLoopId(reportId))
    if (!report) return null
    const dropped = new Set(reportIds(value))
    return touchReport(report, { rows: report.rows.filter((row) => !dropped.has(row.loopId)) })
  })
  ipcMain.handle(IPC.report.refresh, (_event, value: unknown) => {
    const report = ledger?.getReport(assertLoopId(value))
    if (!report) return null
    const fresh = new Map(reportRowsFor(report.rows.map((row) => row.loopId)).map((row) => [row.loopId, row]))
    return touchReport(report, {
      capturedAt: new Date().toISOString(),
      rows: report.rows.map((row) => fresh.get(row.loopId) ?? row),
    })
  })
  ipcMain.handle(IPC.report.remove, (_event, value: unknown) => ledger?.deleteReport(assertLoopId(value)) ?? false)
  ipcMain.handle(IPC.report.markdown, (_event, value: unknown) => {
    const report = ledger?.getReport(assertLoopId(value))
    return report ? renderReportMarkdown(report) : ''
  })
  ipcMain.handle(IPC.report.exportJson, async (_event, value: unknown) => {
    try {
      const report = ledger?.getReport(assertLoopId(value))
      if (!report) return { ok: false, error: 'Report not found.' }
      return await saveReportFile(report, REPORT_FILE_SUFFIX, JSON.stringify(toReportFile(report, new Date().toISOString()), null, 2), 'Export report for a teammate')
    } catch (error) {
      return { ok: false, error: `Could not export report: ${redactedErrorMessage(error, 'Export failed.')}` }
    }
  })
  ipcMain.handle(IPC.report.exportMarkdown, async (_event, value: unknown) => {
    try {
      const report = ledger?.getReport(assertLoopId(value))
      if (!report) return { ok: false, error: 'Report not found.' }
      return await saveReportFile(report, '.md', renderReportMarkdown(report), 'Save report as Markdown')
    } catch (error) {
      return { ok: false, error: `Could not save report: ${redactedErrorMessage(error, 'Export failed.')}` }
    }
  })
  ipcMain.handle(IPC.report.importReport, async () => {
    try {
      if (!mainWindow || !ledger) return { ok: false, error: 'Report import is not ready.' }
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Open a report a teammate sent you',
        buttonLabel: 'Open report',
        filters: [{ name: `${APP_NAME} report`, extensions: ['json'] }],
        properties: ['openFile'],
      })
      const filePath = picked.filePaths[0]
      if (picked.canceled || !filePath) return { ok: false, canceled: true }
      const parsed = parseReportFile(readBoundedReportFile(filePath))
      const report = ledger.saveReport({ ...parsed, id: crypto.randomUUID(), updatedAt: new Date().toISOString() })
      return { ok: true, report, filePath }
    } catch (error) {
      return { ok: false, error: `Could not import report: ${redactedErrorMessage(error, 'Import failed.')}` }
    }
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  // Silent quit here reads as a build failure in `electron-vite dev`: the app
  // window that appears is the instance already running, not this one.
  console.error(`${APP_NAME} is already running — quitting this instance. Quit the existing app first.`)
  app.quit()
}

if (hasSingleInstanceLock) {
  void app.whenReady().then(async () => {
    const appIcon = developmentAppIconPath(app.getAppPath(), app.isPackaged)
    if (process.platform === 'darwin' && appIcon) app.dock?.setIcon(appIcon)
    const attachments = createRunAttachments(protectedWorkspaceRoots)
    registerAttachmentIpc(attachments, () => mainWindow)
    ledger = new Ledger(path.join(app.getPath('userData'), 'ledger.db'), { protectedRoots: protectedWorkspaceRoots })
    loopRunner = new LoopRunner(ledger, (channel, payload) => mainWindow?.webContents.send(channel, payload), {
      protectedRoots: protectedWorkspaceRoots,
      prepareContext: (ids) => attachments.prepare(ids),
      rotateAccount,
    })
    mediaGate = new MediaBaseGate(() => startMediaServer((loopId) => {
      const loop = ledger?.getLoop(loopId)
      if (!loop) return null
      try {
        ledger?.assertLoopWorkspaceIdentity(loopId)
        return loop
      } catch {
        return null
      }
    }))
    steering = new SteeringService(
      ledger,
      createConsultAgent(path.join(app.getPath('userData'), 'consults'), () => subscriptionEnv({ CODEX_HOME: cliHome('codex') }, process.env, 'codex')),
      (channel, payload) => mainWindow?.webContents.send(channel, payload),
      new SteeringAttachments(ledger, attachments),
    )
    await steering.recover()
    registerSteeringIpc(steering)
    registerIpc()
    registerLoopIpc()
    registerReportIpc()
    mainWindow = createWindow()
    if (smokeTestMode) {
      mainWindow.webContents.once('did-finish-load', () => {
        console.log('GAUNTLET_SMOKE_TEST_OK')
        app.quit()
      })
    }
    loopRunner.recoverAll()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

// Loop agents are detached processes and by default survive app quit — the
// next launch re-attaches to them (LoopRunner.recoverAll). When a run is
// live, quitting asks whether to keep them working or stop them gracefully.
let playQuitPending = false
let playQuitSettled = false
app.on('before-quit', (event) => {
  if (playQuitSettled) return
  const active = loopRunner?.activeRun()
  const forcedAgentSettlement = loopRunner?.quitSettlementPending() ?? false
  if (playQuitPending) {
    event.preventDefault()
    return
  }
  let choice = 0
  if (active) {
    choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Keep agents running', 'Stop agents, then quit', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `A loop is running (${active.role}, pid ${active.pid}).`,
      detail:
        'Agents are detached: quitting keeps them working headless and the app re-attaches on the next launch (the loop advances to its next run only while the app is open). Or stop them gracefully (SIGINT) and end the loop now.',
    })
    if (choice === 2) {
      // Cancel means cancel: do not stop a Play server or login terminal before
      // the operator has committed to quitting.
      event.preventDefault()
      return
    }
  }
  harnessLogins.stopAll()
  const stopAgents = choice === 1
  const settleAgents = stopAgents || forcedAgentSettlement
  const settlePlay = hasActivePlay()
  const settleChat = steering?.hasUnfinished() ?? false
  if (!settleAgents && !settlePlay && !settleChat) return
  // Play ownership is intentionally in-memory, and a requested agent stop
  // relies on timers that must finish before Electron exits. Hold the app
  // open until both identity-bound supervisors prove absence.
  event.preventDefault()
  playQuitPending = true
  void (async () => {
    try {
      const settlement = await settleQuitSupervisors(
        async () => !settleAgents || !loopRunner || await loopRunner.stopForQuitAndWait(),
        async () => {
          const results = await Promise.allSettled([
            settlePlay ? stopAllPlayAndWait() : Promise.resolve(),
            settleChat ? steering!.shutdown().then(settled => { if (!settled) throw new Error('Steering chat process ownership is unresolved.') }) : Promise.resolve(),
          ])
          for (const result of results) if (result.status === 'rejected') throw result.reason
        },
      )
      if (!settlement.ok) {
        dialog.showErrorBox(`${APP_NAME} could not finish quitting safely`, settlement.error)
        return
      }
      playQuitSettled = true
      app.quit()
    } finally {
      // A rejected supervisor promise or an unsettled process must never leave
      // the before-quit guard latched forever. The app remains open and a later
      // operator retry re-enters the full confirmation/settlement flow.
      playQuitPending = false
    }
  })()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
