import { trustExistingBuild } from './trust-ipc'
import { createBuildAttachments } from './build-attachments'
import { registerAttachmentIpc } from './attachment-ipc'
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import fixPath from 'fix-path'
import type { AccountRotation, AccountsResult, AccountsState, HarnessAction, HarnessKind } from '../shared/harness'
import { IPC } from '../shared/ipc'
import { type CritiqueRound, type BuildLogLine, type BuildRecord, type ReferenceStudy } from '../shared/build'
import { isCodexModel, resolveModels } from '../shared/models'
import { REPORT_FILE_SUFFIX, type DeleteBuildsResult, type ReportRecord, type ReportBuildRow } from '../shared/reports'
import { referencePackDir, referenceRootForBuild } from '../shared/reference-path'
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
import { cliHome, harnessesRoot } from './harness-env'
import { HarnessLoginManager } from './harness-login'
import { subscriptionAuthError } from './harness-status'
import {
  assertHarnessKind,
  assertBuildId,
  parseLogLimit,
  parseDeleteBuildsInput,
  parseBuildListOffset,
  parseOnboardingHarness,
  parseOptionalRound,
  parseAttemptPageOffset,
  parseAttemptPromptRequest,
  parseRenameInput,
  parseStartBuildInput,
  parseTerminalInput,
  parseTerminalResize,
  renameTrustError,
} from './ipc-input'
import { Ledger } from './ledger'
import { OnboardingStore } from './onboarding'
import { BuildRunner } from './build-runner'
import { stopExistingBuild } from './build-stop'
import { MediaBaseGate, startMediaServer } from './media-server'
import { hasActivePlay, playAccessError, playState, startPlay, stopAllPlayAndWait, stopPlay } from './play'
import { parseReadStreamInput, rawStreamTrustError, readRawStreamChunk, resolveProtectedRawStreamPath } from './raw-streams'
import { scanReferencePack } from './reference-pack'
import { buildReport, scanCritiqueArtifacts } from './report'
import { buildReportRow, parseReportFile, renderReportMarkdown, reportFileBase, toReportFile } from './reports'
import { checkoutRoundRevision, configureRoundRevisionStorage } from './round-revision'
import {
  copyBuildFolder,
  deleteBuildFolder,
  exportActivityError,
  nextAvailableExportPath,
  RAW_EXPORT_WARNING,
  BUILD_LEDGER_FILE,
  BUILD_METADATA_DIR,
  safeExportFolderName,
} from './build-transfer'
import { developmentRendererUrl } from './dev-renderer-url'
import { developmentAppIconPath } from './development-app-icon'
import { assertWorkspaceBoundary, captureWorkspaceIdentity } from './workspace-boundary'
import { boundedBuildSnapshot, buildListPage } from './ipc-projection'
import { withPromptLogs, type PromptLogAttempt } from './prompt-logs'
import { settleQuitSupervisors } from './quit-settlement'
import { readExactFileDescriptor } from './bounded-fd'
import { resolveUserDataOverride } from './user-data-dir'
import { configureAgentWritableRoots } from './cli-executable'

let mainWindow: BrowserWindow | null = null
let ledger: Ledger | null = null
let buildRunner: BuildRunner | null = null
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

/** Where new builds are created when the user has not chosen a folder. */
function defaultWorkspaceParent(): string {
  return path.join(app.getPath('home'), 'GauntletGames')
}

/**
 * Directories an agent can write into: the app's own private state, the folder
 * new builds are created in, and every project folder a build has used. Executable
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
  if (ledger?.runningBuild()) {
    return { ok: false, state: readAccounts(root, kind), error: 'Stop the running build before switching accounts.' }
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
  if (ledger?.runningBuild()) {
    return { ok: false, state: readAccounts(root, kind), error: 'Stop the running build before removing an account.' }
  }
  harnessLogins.cancel(kind)
  await harnessLogins.logout(kind, accountDir(root, kind, accountId))
  return { ok: true, state: removeAccount(root, kind, accountId) }
}

function registerBuildIpc(): void {
  ipcMain.handle(IPC.build.start, async (_event, value: unknown) => {
    if (!buildRunner) return { ok: false, error: 'Build runner not ready.' }
    try {
      const input = parseStartBuildInput(value)
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
      return buildRunner.start({ ...input, ...models }, 'new-child')
    } catch (error) {
      return { ok: false, error: redactedErrorMessage(error, 'Invalid build input.') }
    }
  })
  ipcMain.handle(IPC.build.trust, (_event, value: unknown) => {
    if (!ledger) return failure('Build history is not ready.')
    return trustExistingBuild(ledger, value,
      (options) => mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options),
      (build, line) => {
        mainWindow?.webContents.send(IPC.build.log, line)
        const projection = ledger?.recentAttemptProjectionForBuild(build.id, 200)
        if (projection) mainWindow?.webContents.send(IPC.build.update, boundedBuildSnapshot({ build, attempts: projection.attempts, totalAttempts: ledger!.attemptCount(build.id), detailTruncated: projection.truncatedFields, aggregate: ledger!.attemptAggregate(build.id) }))
      }, hasActivePlay)
  })
  ipcMain.handle(IPC.build.resume, (_event, value: unknown) => {
    try {
      return buildRunner?.resumeBuild(assertBuildId(value)) ?? { ok: false, error: 'Build runner not ready.' }
    } catch (error) {
      return { ok: false, error: redactedErrorMessage(error, 'Invalid build id.') }
    }
  })
  ipcMain.handle(IPC.build.stop, (_event, value: unknown) => {
    try {
      if (!buildRunner || !ledger) return failure('Build runner is not ready.')
      return stopExistingBuild(ledger, buildRunner, assertBuildId(value))
    } catch (error) {
      return failure(redactedErrorMessage(error, 'Invalid build id.'))
    }
  })
  ipcMain.handle(IPC.build.list, (_event, offsetValue: unknown) => {
    const offset = parseBuildListOffset(offsetValue)
    return ledger
      ? buildListPage(ledger.recentBuilds(100, offset), ledger.buildCount(), offset, (buildId) => ledger!.attemptCount(buildId))
      : { snapshots: [], total: 0, offset, hasMore: false }
  })
  ipcMain.handle(IPC.build.get, (_event, value: unknown, offsetValue: unknown) => {
    const build = ledger?.getBuild(assertBuildId(value))
    if (!build || !ledger) return null
    const attemptOffset = parseAttemptPageOffset(offsetValue)
    const projection = ledger.recentAttemptProjectionForBuild(build.id, 200, attemptOffset)
    return boundedBuildSnapshot({ build, attempts: projection.attempts, totalAttempts: ledger.attemptCount(build.id), attemptOffset, detailTruncated: projection.truncatedFields, aggregate: ledger.attemptAggregate(build.id) })
  })
  ipcMain.handle(IPC.build.rename, (_event, buildId: unknown, value: unknown) => {
    try {
      if (!ledger) return failure('Build history is not ready.')
      const input = parseRenameInput(buildId, value)
      const build = ledger.getBuild(input.buildId)
      if (!build) return failure('Build not found.')
      const trustError = renameTrustError(build.playTrusted)
      if (trustError) return failure(trustError)
      ledger.patchBuild(input.buildId, { title: input.title })
      const updated = ledger.getBuild(input.buildId)
      return updated ? success(updated) : failure('Build disappeared while renaming.')
    } catch (error) {
      return failure(redactedErrorMessage(error, 'Could not rename build.'))
    }
  })
  ipcMain.handle(IPC.build.deleteBuilds, async (_event, value: unknown, deleteFilesValue: unknown): Promise<DeleteBuildsResult> => {
    if (!ledger) return { ok: false, deletedIds: [], errors: ['Build storage is not ready.'] }
    try {
      const input = parseDeleteBuildsInput(value, deleteFilesValue)
      const deletedIds: string[] = []
      const errors: string[] = []
      for (const buildId of input.buildIds) {
        const build = ledger.getBuild(buildId)
        if (!build) {
          errors.push('One of the builds was already gone.')
          continue
        }
        if (build.status === 'running') {
          errors.push(`"${build.title}" is still running. Stop it first.`)
          continue
        }
        const sharing = input.deleteFiles
          ? ledger.buildsInWorkspace(build.workspaceDir).filter((other) => other.id !== buildId)
          : []
        if (sharing.length > 0) {
          errors.push(`"${build.title}" shares its project folder with ${sharing.length} other ${sharing.length === 1 ? 'build' : 'builds'}, so the files were kept.`)
        }
        try {
          if (input.deleteFiles && sharing.length === 0) {
            ledger.assertBuildWorkspaceIdentity(buildId)
            await deleteBuildFolder(build.workspaceDir, app.getPath('home'))
          }
          ledger.deleteBuild(buildId)
          deletedIds.push(buildId)
        } catch (error) {
          errors.push(`Could not delete "${build.title}": ${redactedErrorMessage(error, 'Deletion failed safely.')}`)
        }
      }
      return { ok: errors.length === 0, deletedIds, errors }
    } catch (error) {
      return { ok: false, deletedIds: [], errors: [redactedErrorMessage(error, 'Invalid build deletion request.')] }
    }
  })
  ipcMain.handle(IPC.build.active, () => {
    if (!ledger) return null
    const build = ledger.runningBuild() ?? ledger.latestBuild()
    if (!build) return null
    const projection = ledger.recentAttemptProjectionForBuild(build.id, 200)
    return boundedBuildSnapshot({ build, attempts: projection.attempts, totalAttempts: ledger.attemptCount(build.id), detailTruncated: projection.truncatedFields, aggregate: ledger.attemptAggregate(build.id) })
  })
  ipcMain.handle(IPC.build.log, (_event, buildId: unknown, limit: unknown) => {
    if (!ledger) return []
    const id = assertBuildId(buildId)
    const events = ledger.eventsForBuild(id, parseLogLimit(limit))
    const represented = [...new Set(events.slice().reverse().flatMap((event) => event.attemptId ? [event.attemptId] : []))].slice(0, 64).reverse()
    const attempts = represented
      .map((attemptId) => ledger!.promptAttemptForLog(attemptId))
      .filter((attempt): attempt is PromptLogAttempt => attempt != null && attempt.buildId === id)
    const latest = attempts.length === 0 ? ledger.latestPromptAttemptForLog(id) : null
    return withPromptLogs(latest ? [latest] : attempts, events)
  })
  ipcMain.handle(IPC.build.prompt, (_event, buildId: unknown, role: unknown, round: unknown) => {
    try {
      if (!ledger) return failure('Build history is not ready.')
      const input = parseAttemptPromptRequest(buildId, role, round)
      if (!ledger.getBuild(input.buildId)) return failure('Build not found.')
      const prompt = ledger.attemptPrompt(input.buildId, input.role, input.round)
      return prompt ? success(prompt) : failure(`No ${input.role} prompt was recorded for round ${input.round}.`)
    } catch (error) {
      return failure(redactedErrorMessage(error, 'Could not load the exact prompt.'))
    }
  })
  ipcMain.handle(IPC.build.readStream, (_event, value: unknown) => {
    try {
      if (!ledger) return failure('Raw streams are not ready.')
      const input = parseReadStreamInput(value)
      const attempt = ledger.getAttempt(input.attemptId)
      if (!attempt) return failure('Build not found.')
      if (input.stream === 'agent' && !attempt.metrics?.agents.some((agent) => agent.id === input.agentId)) {
        return failure('Agent stream does not belong to this attempt.')
      }
      const build = ledger.getBuild(attempt.buildId)
      if (!build) return failure('Build owner not found.')
      const trustError = rawStreamTrustError(build.playTrusted)
      if (trustError) return failure(trustError)
      const workspaceDir = ledger.assertBuildWorkspaceIdentity(build.id)
      const latestImplementAttemptId = ledger.latestAttemptIdForRole(build.id, 'implement')
      const streamPath = resolveProtectedRawStreamPath(
        {
          workspaceDir,
          attemptId: attempt.id,
          sessionId: attempt.sessionId,
          claudeHome: cliHome('claude'),
          codexHome: cliHome('codex'),
          allowLiveChildStream: latestImplementAttemptId === attempt.id,
        },
        input,
        protectedWorkspaceRoots(),
      )
      return success(readRawStreamChunk(streamPath, input.offset, input.identity))
    } catch (error) {
      return failure(redactedErrorMessage(error, 'Could not read raw stream.'))
    }
  })
  ipcMain.handle(IPC.build.report, (_event, value: unknown) => {
    try {
      if (!ledger) return failure('Build history is not ready.')
      const build = ledger.getBuild(assertBuildId(value))
      if (!build) return failure('Build not found.')
      ledger!.assertBuildWorkspaceIdentity(build.id)
      const totalAttempts = ledger.attemptCount(build.id)
      const attempts = ledger.recentAttemptProjectionForBuild(build.id, 500).attempts
      const referenceDir = referenceRootForBuild(build.id, ledger.hasAttemptRole(build.id, 'reference'))
      return success(buildReport(
        build,
        attempts,
        scanCritiqueArtifacts(build.workspaceDir, build),
        scanReferencePack(build.workspaceDir, referenceDir, build),
        { totalAttempts, aggregate: ledger.attemptAggregate(build.id) },
      ))
    } catch (error) {
      return failure(redactedErrorMessage(error, 'Could not build report.'))
    }
  })
  ipcMain.handle(IPC.build.exportBuild, async (_event, value: unknown) => {
    try {
      if (!mainWindow || !ledger) return { ok: false, error: 'Build export is not ready.' }
      const build = ledger.getBuild(assertBuildId(value))
      if (!build) return { ok: false, error: 'Build not found.' }
      ledger.assertBuildWorkspaceIdentity(build.id)
      const activityError = exportActivityError(ledger.hasRunningActivity(), hasActivePlay())
      if (activityError) return { ok: false, error: activityError }
      if (ledger.hasAttemptErrorPrefixForWorkspace(build.workspaceDir, 'Launch identity was not durably recorded before the app exited.')) {
        return { ok: false, error: 'This workspace is quarantined after unknown process ownership and cannot be exported while an untracked writer may survive.' }
      }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Export complete build folder',
        message: `${RAW_EXPORT_WARNING} Choose where ${APP_NAME} should copy the complete project and its exact SQLite history.`,
        buttonLabel: 'Export here',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory'],
      })
      const parentDir = result.filePaths[0]
      if (result.canceled || !parentDir) return { ok: false, canceled: true }
      const changedActivityError = exportActivityError(ledger.hasRunningActivity(), hasActivePlay())
      if (changedActivityError) return { ok: false, error: changedActivityError }
      if (ledger.hasAttemptErrorPrefixForWorkspace(build.workspaceDir, 'Launch identity was not durably recorded before the app exited.')) {
        return { ok: false, error: 'This workspace is quarantined after unknown process ownership and cannot be exported while an untracked writer may survive.' }
      }
      assertWorkspaceBoundary(parentDir, protectedWorkspaceRoots())
      const sourceDir = ledger.prepareBuildFolder(build.id)
      const destinationDir = nextAvailableExportPath(parentDir, safeExportFolderName(path.basename(sourceDir)))
      await copyBuildFolder(sourceDir, destinationDir, build.workspaceIdentity)
      return { ok: true, filePath: destinationDir, warning: RAW_EXPORT_WARNING }
    } catch (error) {
      return { ok: false, error: `Could not export build: ${redactedErrorMessage(error, 'Unknown export failure.')}` }
    }
  })
  ipcMain.handle(IPC.build.importBuild, async () => {
    try {
      if (!mainWindow || !ledger) return { ok: false, error: 'Build import is not ready.' }
      const pickedExport = await dialog.showOpenDialog(mainWindow, {
        title: 'Open exported build folder',
        message: `Choose the transferred project folder containing ${BUILD_METADATA_DIR}/${BUILD_LEDGER_FILE}.`,
        buttonLabel: 'Open build folder',
        properties: ['openDirectory'],
      })
      const workspaceDir = pickedExport.filePaths[0]
      if (pickedExport.canceled || !workspaceDir) return { ok: false, canceled: true }
      assertWorkspaceBoundary(workspaceDir, protectedWorkspaceRoots())
      const snapshots = ledger.importBuildFolder(workspaceDir)
      const primary = snapshots[0]
        ? boundedBuildSnapshot({ ...snapshots[0], aggregate: ledger.attemptAggregate(snapshots[0].build.id) })
        : undefined
      return {
        ok: true,
        snapshot: primary,
        snapshots: primary ? [primary] : [],
      }
    } catch (error) {
      return { ok: false, error: `Could not import build: ${redactedErrorMessage(error, 'Unknown import failure.')}` }
    }
  })
  ipcMain.handle(IPC.media.base, async (): Promise<OperationResult<string>> =>
    mediaGate ? await mediaGate.get() : failure('Media server has not started yet.'))
  ipcMain.handle(IPC.build.critique, (_event, value: unknown) => {
    try {
      if (!ledger) return failure('Build history is not ready.')
      const build = ledger.getBuild(assertBuildId(value))
      if (!build) return failure('Build not found.')
      ledger.assertBuildWorkspaceIdentity(build.id)
      const artifacts = new Map(scanCritiqueArtifacts(build.workspaceDir, build).map((artifact) => [artifact.round, artifact]))
      const byRound = new Map<number, CritiqueRound>()
      const totalCritiques = ledger.attemptCountByRole(build.id, 'critique')
      const critiqueProjection = ledger.latestAttemptProjectionPerRound(build.id, 'critique', 100)
      const critiqueAttempts = critiqueProjection.attempts
      let remainingThoughtBytes = 512 * 1024
      for (const attempt of boundedBuildSnapshot({ build, attempts: critiqueAttempts, totalAttempts: totalCritiques }).attempts) {
        const artifact = artifacts.get(attempt.round)
        const thoughtRows = ledger.eventsForAttempt(attempt.id, 'thought', 50)
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
        byRound.set(attempt.round, {
          round: attempt.round,
          attemptId: attempt.id,
          status: attempt.status,
          verdict: attempt.verdict,
          thoughts,
          shots: artifact?.shots ?? [],
          refs: artifact?.refs ?? [],
          videos: artifact?.videos ?? [],
          pairs: artifact?.pairs ?? null,
          pairsMd: artifact?.pairsMd ?? null,
          truncated: (artifact?.truncated ?? false) || thoughtTruncated || totalCritiques > critiqueAttempts.length || critiqueProjection.truncatedFields,
        })
      }
      return success([...byRound.values()].sort((a, b) => a.round - b.round))
    } catch (error) {
      return failure(redactedErrorMessage(error, 'Could not load critique details.'))
    }
  })
  ipcMain.handle(IPC.build.reference, (_event, buildValue: unknown, attemptValue: unknown): ReferenceStudy | null => {
    if (!ledger) return null
    const build = ledger.getBuild(assertBuildId(buildValue))
    const attempt = attemptValue == null ? ledger.latestAttemptForBuildByRole(build?.id ?? '', 'reference') : ledger.getAttempt(assertBuildId(attemptValue))
    if (!build || !attempt || attempt.buildId !== build.id || attempt.role !== 'reference') return null
    try {
      ledger.assertBuildWorkspaceIdentity(build.id)
    } catch {
      return null
    }
    return {
      attemptId: attempt.id,
      status: attempt.status,
      prompt: attempt.prompt,
      logs: withPromptLogs([attempt], ledger.eventsForAttempt(attempt.id, undefined, 500)),
      pack: scanReferencePack(build.workspaceDir, referencePackDir(build.id), build),
    }
  })
  ipcMain.handle(IPC.play.start, (_event, value: unknown, roundValue: unknown) => {
    const build = ledger?.getBuild(assertBuildId(value))
    if (!build) return { running: false, url: null, error: 'Build not found.', round: null }
    const accessError = playAccessError(build)
    if (accessError) {
      return {
        running: false,
        url: null,
        error: accessError,
        round: null,
      }
    }
    try {
      ledger!.assertBuildWorkspaceIdentity(build.id)
    } catch (error) {
      return { running: false, url: null, error: redactedErrorMessage(error, 'The workspace path is unsafe.'), round: null }
    }
    const round = parseOptionalRound(roundValue)
    const revision = round == null
      ? null
      : ledger?.succeededImplementRevision(build.id, round)
    if (round != null && !revision) {
      return {
        ...playState(build.id),
        error: `Round ${round} has no saved Git revision. Revisions are available for rounds completed after this feature was installed.`,
      }
    }
    try {
      const playDir = revision ? checkoutRoundRevision(build.workspaceDir, build.id, round!, revision) : build.workspaceDir
      const expectedWorkspace = revision
        ? captureWorkspaceIdentity(playDir, protectedWorkspaceRoots())
        : build
      return startPlay(
        build.id,
        playDir,
        round,
        revision ? playDir : null,
        (state) => mainWindow?.webContents.send(IPC.play.state, state),
        {},
        { expectedWorkspace, protectedRoots: protectedWorkspaceRoots() },
      )
    } catch (error) {
      return {
        ...playState(build.id),
        error: `Could not check out round ${round}: ${redactedErrorMessage(error, 'Unknown checkout failure.')}`,
      }
    }
  })
  ipcMain.handle(IPC.play.stop, (_event, value: unknown) => {
    const buildId = assertBuildId(value)
    stopPlay(buildId)
  })
  ipcMain.handle(IPC.play.state, (_event, value: unknown) => playState(assertBuildId(value)))
  ipcMain.handle(IPC.build.pickWorkspace, async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where new build folders are created',
      buttonLabel: 'Use for new builds',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.build.defaultWorkspace, () => defaultWorkspaceParent())
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
    if (ledger?.runningBuild()) return { ok: false, error: 'Stop the running build before signing out.' }
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
  if (!Array.isArray(value) || value.length > 1_000) throw new Error('Report build ids must be an array of at most 1000 ids.')
  return [...new Set(value.map(assertBuildId))]
}

function reportName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Report name must be a string.')
  const name = value.trim()
  if (!name || name.length > 80) throw new Error('Report name must be between 1 and 80 characters.')
  return name
}

function reportRowsFor(buildIds: readonly string[]): ReportBuildRow[] {
  if (!ledger) return []
  const store = ledger
  return buildIds
    .map((id) => store.getBuild(id))
    .filter((build): build is BuildRecord => build != null)
    .map((build) => buildReportRow({ build, attempts: store.attemptsForBuild(build.id) }))
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
  ipcMain.handle(IPC.report.get, (_event, value: unknown) => ledger?.getReport(assertBuildId(value)) ?? null)
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
    const report = ledger?.getReport(assertBuildId(reportId))
    return report ? touchReport(report, { name: reportName(value) }) : null
  })
  ipcMain.handle(IPC.report.addBuilds, (_event, reportId: unknown, value: unknown) => {
    const report = ledger?.getReport(assertBuildId(reportId))
    if (!report) return null
    const present = new Set(report.rows.map((row) => row.buildId))
    const ids = reportIds(value).filter((id) => !present.has(id))
    return ids.length > 0 ? touchReport(report, { rows: [...report.rows, ...reportRowsFor(ids)] }) : report
  })
  ipcMain.handle(IPC.report.removeBuilds, (_event, reportId: unknown, value: unknown) => {
    const report = ledger?.getReport(assertBuildId(reportId))
    if (!report) return null
    const dropped = new Set(reportIds(value))
    return touchReport(report, { rows: report.rows.filter((row) => !dropped.has(row.buildId)) })
  })
  ipcMain.handle(IPC.report.refresh, (_event, value: unknown) => {
    const report = ledger?.getReport(assertBuildId(value))
    if (!report) return null
    const fresh = new Map(reportRowsFor(report.rows.map((row) => row.buildId)).map((row) => [row.buildId, row]))
    return touchReport(report, {
      capturedAt: new Date().toISOString(),
      rows: report.rows.map((row) => fresh.get(row.buildId) ?? row),
    })
  })
  ipcMain.handle(IPC.report.remove, (_event, value: unknown) => ledger?.deleteReport(assertBuildId(value)) ?? false)
  ipcMain.handle(IPC.report.markdown, (_event, value: unknown) => {
    const report = ledger?.getReport(assertBuildId(value))
    return report ? renderReportMarkdown(report) : ''
  })
  ipcMain.handle(IPC.report.exportJson, async (_event, value: unknown) => {
    try {
      const report = ledger?.getReport(assertBuildId(value))
      if (!report) return { ok: false, error: 'Report not found.' }
      return await saveReportFile(report, REPORT_FILE_SUFFIX, JSON.stringify(toReportFile(report, new Date().toISOString()), null, 2), 'Export report for a teammate')
    } catch (error) {
      return { ok: false, error: `Could not export report: ${redactedErrorMessage(error, 'Export failed.')}` }
    }
  })
  ipcMain.handle(IPC.report.exportMarkdown, async (_event, value: unknown) => {
    try {
      const report = ledger?.getReport(assertBuildId(value))
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
  void app.whenReady().then(() => {
    const appIcon = developmentAppIconPath(app.getAppPath(), app.isPackaged)
    if (process.platform === 'darwin' && appIcon) app.dock?.setIcon(appIcon)
    const attachments = createBuildAttachments(protectedWorkspaceRoots)
    registerAttachmentIpc(attachments, () => mainWindow)
    ledger = new Ledger(path.join(app.getPath('userData'), 'ledger.db'), { protectedRoots: protectedWorkspaceRoots })
    buildRunner = new BuildRunner(ledger, (channel, payload) => mainWindow?.webContents.send(channel, payload), {
      protectedRoots: protectedWorkspaceRoots,
      prepareContext: (ids) => attachments.prepare(ids),
      rotateAccount,
    })
    mediaGate = new MediaBaseGate(() => startMediaServer((buildId) => {
      const build = ledger?.getBuild(buildId)
      if (!build) return null
      try {
        ledger?.assertBuildWorkspaceIdentity(buildId)
        return build
      } catch {
        return null
      }
    }))
    registerIpc()
    registerBuildIpc()
    registerReportIpc()
    mainWindow = createWindow()
    if (smokeTestMode) {
      mainWindow.webContents.once('did-finish-load', () => {
        console.log('GAUNTLET_SMOKE_TEST_OK')
        app.quit()
      })
    }
    buildRunner.recoverAll()

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

// Build agents are detached processes and by default survive app quit — the
// next launch re-attaches to them (BuildRunner.recoverAll). When a build is
// live, quitting asks whether to keep them working or stop them gracefully.
let playQuitPending = false
let playQuitSettled = false
app.on('before-quit', (event) => {
  if (playQuitSettled) return
  const active = buildRunner?.activeAttempt()
  const forcedAgentSettlement = buildRunner?.quitSettlementPending() ?? false
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
      message: `A build is running (${active.role}, pid ${active.pid}).`,
      detail:
        'Agents are detached: quitting keeps them working headless and the app re-attaches on the next launch (the build advances to its next attempt only while the app is open). Or stop them gracefully (SIGINT) and end the build now.',
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
  if (!settleAgents && !settlePlay) return
  // Play ownership is intentionally in-memory, and a requested agent stop
  // relies on timers that must finish before Electron exits. Hold the app
  // open until both identity-bound supervisors prove absence.
  event.preventDefault()
  playQuitPending = true
  void (async () => {
    try {
      const settlement = await settleQuitSupervisors(
        async () => !settleAgents || !buildRunner || await buildRunner.stopForQuitAndWait(),
        async () => { if (settlePlay) await stopAllPlayAndWait() },
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
