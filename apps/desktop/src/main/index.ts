import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import pty, { type IPty } from 'node-pty'
import type {
  DetectionResult,
  HarnessAction,
  HarnessKind,
  LoginEvent,
  ProbeResult,
  TerminalDataEvent,
} from '../shared/harness'
import { harnessKinds } from '../shared/harness'
import type { CritiqueRound, LoopRecord, StartLoopInput } from '../shared/loop'
import { isCodexModel, resolveModels } from '../shared/models'
import { REPORT_FILE_SUFFIX, type DeleteRunsResult, type ReportRecord, type ReportRunRow } from '../shared/reports'
import { cliHome, subscriptionEnv } from './harness-env'
import { Ledger } from './ledger'
import { LoopRunner } from './loop-runner'
import { startMediaServer } from './media-server'
import { playState, startPlay, stopAllPlay, stopPlay } from './play'
import { buildReport, scanCritiqueArtifacts } from './report'
import { checkoutRoundRevision } from './round-revision'
import { buildReportRow, parseReportFile, renderReportMarkdown, reportFileBase, toReportFile } from './reports'
import { copyRunFolder, deleteRunFolder, nextAvailableExportPath, safeExportFolderName } from './run-transfer'

interface HarnessSpec {
  command: string
  versionArgs: string[]
  statusArgs: string[]
  loginArgs: string[]
  env: Record<string, string>
}

interface CommandResult {
  ok: boolean
  code?: number | null
  stdout: string
  stderr: string
  error?: string
}

interface ClaudeStatus {
  loggedIn?: boolean
  authMethod?: string
  apiProvider?: string
  subscriptionType?: string
  orgName?: string
  email?: string
}

const runningLogins = new Map<HarnessKind, IPty>()
const validHarnessKinds = new Set<string>(harnessKinds)
let mainWindow: BrowserWindow | null = null
let ledger: Ledger | null = null
let loopRunner: LoopRunner | null = null
let mediaBase: string | null = null

app.setName('Gauntlet Loop')
app.setPath('userData', path.join(app.getPath('appData'), 'Gauntlet Loop'))

function assertHarnessKind(value: unknown): HarnessKind {
  if (typeof value !== 'string' || !validHarnessKinds.has(value)) {
    throw new Error('Unsupported harness.')
  }
  return value as HarnessKind
}

function harnessSpec(kind: HarnessKind): HarnessSpec {
  if (kind === 'claude') {
    return {
      command: 'claude',
      versionArgs: ['--version'],
      statusArgs: ['auth', 'status', '--json'],
      loginArgs: ['auth', 'login', '--claudeai'],
      env: { CLAUDE_CONFIG_DIR: cliHome(kind) },
    }
  }

  return {
    command: 'codex',
    versionArgs: ['--version'],
    statusArgs: ['login', 'status'],
    loginArgs: ['login'],
    env: { CODEX_HOME: cliHome(kind) },
  }
}

function run(command: string, args: string[], env: Record<string, string>, timeoutMs = 8_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: subscriptionEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout

    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (error) => finish({ ok: false, stdout, stderr, error: error.message }))
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }))

    timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ ok: false, stdout, stderr, error: 'Command timed out.' })
    }, timeoutMs)
  })
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}

function parseUrls(value: string): string[] {
  return stripAnsi(value).match(/https?:\/\/[^\s<>"']+/g) ?? []
}

async function detect(kind: HarnessKind): Promise<DetectionResult> {
  const spec = harnessSpec(kind)
  const result = await run(spec.command, spec.versionArgs, spec.env)
  const version = stripAnsi(result.stdout || result.stderr).trim().split('\n')[0] || null
  return {
    found: result.ok,
    version,
    error: result.ok ? null : ((result.error ?? result.stderr.trim()) || null),
  }
}

async function probe(kind: HarnessKind): Promise<ProbeResult> {
  const spec = harnessSpec(kind)
  const result = await run(spec.command, spec.statusArgs, spec.env)

  if (kind === 'claude') {
    try {
      const status = JSON.parse(result.stdout) as ClaudeStatus
      const loggedIn = Boolean(status.loggedIn)
      return {
        loggedIn,
        authMethod: loggedIn ? (status.authMethod ?? 'Claude account') : null,
        details: loggedIn
          ? [
              ['Version', (await detect(kind)).version],
              ['Provider', status.apiProvider === 'firstParty' ? 'Anthropic API' : status.apiProvider],
              [
                'Login method',
                status.subscriptionType ? `Claude ${status.subscriptionType} account` : status.authMethod,
              ],
              ['Organization', status.orgName],
              ['Email', status.email],
            ].filter((detail): detail is [string, string] => Boolean(detail[1]))
          : [],
      }
    } catch {
      const message = stripAnsi(result.stderr || result.stdout).trim()
      return { loggedIn: false, error: /not logged in|not authenticated/i.test(message) ? null : message || null }
    }
  }

  const text = stripAnsi(`${result.stdout}\n${result.stderr}`).trim()
  const loggedIn = result.ok && /^logged in using\b/i.test(text)
  return {
    loggedIn,
    authMethod: loggedIn ? text.replace(/^logged in using\s*/i, '') || 'Codex account' : null,
    details: loggedIn
      ? [
          ['Version', (await detect(kind)).version ?? 'Unknown'],
          ['Provider', 'OpenAI'],
          ['Auth', text.replace(/^logged in using\s*/i, '') || 'CLI account'],
          ['Credentials', 'Managed privately by Codex CLI'],
        ]
      : [],
    error: loggedIn || /not logged in|not authenticated/i.test(text) ? null : text || null,
  }
}

async function verifyLogin(kind: HarnessKind): Promise<ProbeResult> {
  let status: ProbeResult = { loggedIn: false }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    status = await probe(kind)
    if (status.loggedIn) return status
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return status
}

function sendLoginAction(kind: HarnessKind, action: HarnessAction): void {
  const event: LoginEvent = { kind, action }
  mainWindow?.webContents.send('harness:login-event', event)
}

function sendTerminalData(kind: HarnessKind, data: string): void {
  const event: TerminalDataEvent = { kind, data }
  mainWindow?.webContents.send('harness:terminal-data', event)
}

function startLogin(kind: HarnessKind): void {
  if (runningLogins.has(kind)) return
  const spec = harnessSpec(kind)
  let child: IPty

  try {
    child = pty.spawn(spec.command, spec.loginArgs, {
      name: 'xterm-256color',
      cols: 100,
      rows: 22,
      cwd: app.getPath('home'),
      env: subscriptionEnv(spec.env),
    })
  } catch (error) {
    sendLoginAction(kind, {
      type: 'login_failed',
      error: error instanceof Error ? error.message : 'Unable to start the login process.',
    })
    return
  }

  runningLogins.set(kind, child)
  sendLoginAction(kind, { type: 'login_started' })

  let transcript = ''
  let emittedUrl: string | null = null
  child.onData((chunk) => {
    transcript = `${transcript}${chunk}`.slice(-16_000)
    sendTerminalData(kind, chunk)
    const url = parseUrls(transcript).at(-1)?.replace(/[),.;]+$/, '')
    if (url && url !== emittedUrl) {
      emittedUrl = url
      sendLoginAction(kind, { type: 'login_url', url })
    }
  })

  child.onExit(async ({ exitCode, signal }) => {
    runningLogins.delete(kind)
    if (signal || exitCode === 130 || exitCode === 143) {
      sendLoginAction(kind, { type: 'login_cancelled' })
      return
    }

    const status = await verifyLogin(kind)
    if (status.loggedIn) {
      sendLoginAction(kind, { type: 'probe_finished', ...status })
      return
    }

    sendLoginAction(kind, {
      type: 'login_failed',
      error: `Login command exited ${exitCode}, but the CLI is not signed in.`,
    })
  })
}

function stopAllLogins(): void {
  for (const child of runningLogins.values()) child.kill()
  runningLogins.clear()
}

function registerLoopIpc(): void {
  ipcMain.handle('loop:start', async (_event, value: unknown) => {
    if (!loopRunner) return { ok: false, error: 'Loop runner not ready.' }
    const input = value as Partial<StartLoopInput> | undefined
    const models = resolveModels(input, input)
    // Any role can run on either CLI now, so a run needs whichever logins its
    // three picks actually reach for.
    const needsCodex = [models.orchestratorModel, models.subagentModel, models.criticModel].some(isCodexModel)
    const needsClaude = [models.orchestratorModel, models.subagentModel, models.criticModel].some((m) => m != null && !isCodexModel(m))
    const [claudeStatus, codexStatus] = await Promise.all([probe('claude'), needsCodex ? probe('codex') : Promise.resolve(null)])
    if (needsClaude && !claudeStatus.loggedIn) return { ok: false, error: 'Claude Code is not connected. Sign in on the Agents tab.' }
    if (needsCodex && !codexStatus?.loggedIn) return { ok: false, error: 'Codex is not connected. Sign in on the Agents tab.' }
    return loopRunner.start({
      prompt: String(input?.prompt ?? ''),
      workspaceDir: String(input?.workspaceDir ?? ''),
      maxRounds: Number(input?.maxRounds ?? 10),
      budgetUsd: input?.budgetUsd == null ? null : Number(input.budgetUsd) || null,
      orchestratorModel: models.orchestratorModel,
      orchestratorEffort: models.orchestratorEffort,
      subagentModel: models.subagentModel,
      subagentEffort: models.subagentEffort,
      criticModel: models.criticModel,
      criticEffort: models.criticEffort,
    })
  })
  ipcMain.handle('loop:resume', (_event, value: unknown) => loopRunner?.resumeLoop(String(value)) ?? { ok: false, error: 'Loop runner not ready.' })
  ipcMain.handle('loop:stop', (_event, value: unknown) => loopRunner?.stop(String(value)))
  ipcMain.handle('loop:list', () =>
    ledger?.loops().map((loop) => ({ loop, runs: ledger!.runsForLoop(loop.id) })) ?? [],
  )
  ipcMain.handle('loop:get', (_event, value: unknown) => {
    const loop = ledger?.getLoop(String(value))
    return loop && ledger ? { loop, runs: ledger.runsForLoop(loop.id) } : null
  })
  ipcMain.handle('loop:rename', (_event, loopId: unknown, value: unknown) => {
    if (!ledger) return null
    const title = String(value ?? '').trim().slice(0, 80)
    if (!title || !ledger.getLoop(String(loopId))) return null
    ledger.patchLoop(String(loopId), { title })
    return ledger.getLoop(String(loopId))
  })
  ipcMain.handle('loop:delete', async (_event, value: unknown, deleteFilesValue: unknown): Promise<DeleteRunsResult> => {
    if (!ledger) return { ok: false, deletedIds: [], errors: ['Run storage is not ready.'] }
    const loopIds = Array.isArray(value) ? value.map((id) => String(id)) : []
    const deleteFiles = deleteFilesValue === true
    const home = app.getPath('home')
    const deletedIds: string[] = []
    const errors: string[] = []
    for (const loopId of loopIds) {
      const loop = ledger.getLoop(loopId)
      if (!loop) {
        errors.push('One of the runs was already gone.')
        continue
      }
      if (loop.status === 'running') {
        errors.push(`"${loop.title}" is still running. Stop it first.`)
        continue
      }
      // Wiping the folder would take the other runs recorded in it with it.
      const sharing = deleteFiles ? ledger.loopsInWorkspace(loop.workspaceDir).filter((other) => other.id !== loopId) : []
      if (sharing.length > 0) {
        errors.push(
          `"${loop.title}" shares its project folder with ${sharing.length} other ${sharing.length === 1 ? 'run' : 'runs'}, so the files were kept.`,
        )
      }
      try {
        if (deleteFiles && sharing.length === 0) await deleteRunFolder(loop.workspaceDir, home)
        ledger.deleteLoop(loopId)
        deletedIds.push(loopId)
      } catch (error) {
        errors.push(`Could not delete "${loop.title}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { ok: errors.length === 0, deletedIds, errors }
  })
  ipcMain.handle('loop:active', () => loopRunner?.snapshot() ?? null)
  ipcMain.handle('loop:log', (_event, loopId: unknown, limit: unknown) =>
    ledger?.eventsForLoop(String(loopId), Math.min(2000, Math.max(1, Number(limit) || 800))) ?? [],
  )
  ipcMain.handle('loop:report', (_event, value: unknown) => {
    const loop = ledger?.getLoop(String(value))
    return loop && ledger ? buildReport(loop, ledger.runsForLoop(loop.id), scanCritiqueArtifacts(loop.workspaceDir)) : ''
  })
  ipcMain.handle('loop:export', async (_event, value: unknown) => {
    try {
      if (!mainWindow || !ledger) return { ok: false, error: 'Run export is not ready.' }
      const loop = ledger.getLoop(String(value))
      if (!loop) return { ok: false, error: 'Run not found.' }
      if (loop.status === 'running') return { ok: false, error: 'Stop the run before exporting so the folder and SQLite history are an exact snapshot.' }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Export complete run folder',
        message: 'Choose where Gauntlet Loop should copy the complete project and its exact SQLite history.',
        buttonLabel: 'Export here',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory'],
      })
      const parentDir = result.filePaths[0]
      if (result.canceled || !parentDir) return { ok: false, canceled: true }
      const sourceDir = ledger.prepareRunFolder(loop.id)
      const destinationDir = nextAvailableExportPath(parentDir, safeExportFolderName(path.basename(sourceDir)))
      await copyRunFolder(sourceDir, destinationDir)
      return { ok: true, filePath: destinationDir }
    } catch (error) {
      return { ok: false, error: `Could not export run: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
  ipcMain.handle('loop:import', async () => {
    try {
      if (!mainWindow || !ledger) return { ok: false, error: 'Run import is not ready.' }
      const pickedExport = await dialog.showOpenDialog(mainWindow, {
        title: 'Open exported run folder',
        message: 'Choose the transferred project folder containing .gauntlet-loop/ledger.db.',
        buttonLabel: 'Open run folder',
        properties: ['openDirectory'],
      })
      const workspaceDir = pickedExport.filePaths[0]
      if (pickedExport.canceled || !workspaceDir) return { ok: false, canceled: true }
      const snapshots = ledger.importRunFolder(workspaceDir)
      return { ok: true, snapshot: snapshots[0], snapshots }
    } catch (error) {
      return { ok: false, error: `Could not import run: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
  ipcMain.handle('media:base', () => mediaBase)
  ipcMain.handle('loop:critique', (_event, value: unknown): CritiqueRound[] => {
    const loop = ledger?.getLoop(String(value))
    if (!loop || !ledger) return []
    const artifacts = new Map(scanCritiqueArtifacts(loop.workspaceDir).map((a) => [a.round, a]))
    const byRound = new Map<number, CritiqueRound>()
    for (const run of ledger.runsForLoop(loop.id)) {
      if (run.role !== 'critique') continue
      const art = artifacts.get(run.round)
      byRound.set(run.round, {
        round: run.round,
        runId: run.id,
        status: run.status,
        verdict: run.verdict,
        thoughts: ledger.eventsForRun(run.id, 'thought').map((l) => l.text.replace(/^\[critic\]\s*𝜓?\s*/, '')),
        shots: art?.shots ?? [],
        refs: art?.refs ?? [],
        videos: art?.videos ?? [],
        pairs: art?.pairs ?? null,
        pairsMd: art?.pairsMd ?? null,
      })
    }
    return [...byRound.values()].sort((a, b) => a.round - b.round)
  })
  ipcMain.handle('play:start', (_event, value: unknown, roundValue: unknown) => {
    const loop = ledger?.getLoop(String(value))
    if (!loop) return { running: false, url: null, error: 'Loop not found.', round: null }
    const round = roundValue == null ? null : Number(roundValue)
    if (round != null && (!Number.isInteger(round) || round < 1)) {
      return { running: false, url: null, error: 'Invalid round.', round: null }
    }
    const revision = round == null
      ? null
      : ledger?.runsForLoop(loop.id).find((run) => run.role === 'implement' && run.round === round && run.status === 'succeeded')?.revision
    if (round != null && !revision) {
      return {
        ...playState(loop.id),
        error: `Round ${round} has no saved Git revision. Revisions are available for rounds completed after this feature was installed.`,
      }
    }
    try {
      const playDir = revision ? checkoutRoundRevision(loop.workspaceDir, round!, revision) : loop.workspaceDir
      return startPlay(loop.id, playDir, round, revision ? playDir : null, (state) => mainWindow?.webContents.send('play:state', state))
    } catch (error) {
      return {
        ...playState(loop.id),
        error: `Could not check out round ${round}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  })
  ipcMain.handle('play:stop', (_event, value: unknown) => {
    stopPlay(String(value))
    mainWindow?.webContents.send('play:state', { loopId: String(value), running: false, url: null, error: null, round: null })
  })
  ipcMain.handle('play:state', (_event, value: unknown) => playState(String(value)))
  ipcMain.handle('loop:pick-workspace', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('loop:default-workspace', () => path.join(app.getPath('home'), 'GauntletRuns', 'aaa-shooter'))
}

function registerIpc(): void {
  ipcMain.handle('harness:detect', (_event, value: unknown) => detect(assertHarnessKind(value)))
  ipcMain.handle('harness:probe', (_event, value: unknown) => probe(assertHarnessKind(value)))
  ipcMain.handle('harness:start-login', (_event, value: unknown) => startLogin(assertHarnessKind(value)))
  ipcMain.handle('harness:cancel-login', (_event, value: unknown) => runningLogins.get(assertHarnessKind(value))?.kill())
  ipcMain.on('harness:terminal-input', (_event, payload: { kind?: unknown; data?: unknown }) => {
    if (typeof payload?.data !== 'string' || payload.data.length > 16_384) return
    runningLogins.get(assertHarnessKind(payload.kind))?.write(payload.data)
  })
  ipcMain.on('harness:terminal-resize', (_event, payload: { kind?: unknown; cols?: unknown; rows?: unknown }) => {
    const cols = Math.max(20, Math.min(300, Math.floor(Number(payload?.cols))))
    const rows = Math.max(5, Math.min(100, Math.floor(Number(payload?.rows))))
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    runningLogins.get(assertHarnessKind(payload.kind))?.resize(cols, rows)
  })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: 'Gauntlet Loop',
    backgroundColor: '#100d0e',
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
    stopAllLogins()
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return window
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  // Silent quit here reads as a build failure in `electron-vite dev`: the app
  // window that appears is the instance already running, not this one.
  console.error('Gauntlet Loop is already running — quitting this instance. Quit the existing app first.')
  app.quit()
}

function reportRowsFor(loopIds: readonly string[]): ReportRunRow[] {
  if (!ledger) return []
  const store = ledger
  return loopIds
    .map((id) => store.getLoop(id))
    .filter((loop): loop is LoopRecord => loop != null)
    .map((loop) => buildReportRow({ loop, runs: store.runsForLoop(loop.id) }))
}

/** Save an edited report, stamping the change time. */
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
  ipcMain.handle('report:list', () => ledger?.reports() ?? [])
  ipcMain.handle('report:get', (_event, value: unknown) => ledger?.getReport(String(value)) ?? null)
  ipcMain.handle('report:create', (_event, nameValue: unknown, value: unknown) => {
    if (!ledger) return null
    const loopIds = Array.isArray(value) ? value.map((id) => String(id)) : []
    const stamp = new Date().toISOString()
    return ledger.saveReport({
      id: crypto.randomUUID(),
      name: String(nameValue ?? '').trim().slice(0, 80) || 'Untitled report',
      createdAt: stamp,
      updatedAt: stamp,
      capturedAt: stamp,
      rows: reportRowsFor(loopIds),
    })
  })
  ipcMain.handle('report:rename', (_event, reportId: unknown, value: unknown) => {
    const report = ledger?.getReport(String(reportId))
    const name = String(value ?? '').trim().slice(0, 80)
    if (!report || !name) return null
    return touchReport(report, { name })
  })
  ipcMain.handle('report:add-runs', (_event, reportId: unknown, value: unknown) => {
    const report = ledger?.getReport(String(reportId))
    if (!report) return null
    const present = new Set(report.rows.map((row) => row.loopId))
    const loopIds = (Array.isArray(value) ? value.map((id) => String(id)) : []).filter((id) => !present.has(id))
    if (loopIds.length === 0) return report
    return touchReport(report, { rows: [...report.rows, ...reportRowsFor(loopIds)] })
  })
  ipcMain.handle('report:remove-runs', (_event, reportId: unknown, value: unknown) => {
    const report = ledger?.getReport(String(reportId))
    if (!report) return null
    const dropped = new Set(Array.isArray(value) ? value.map((id) => String(id)) : [])
    return touchReport(report, { rows: report.rows.filter((row) => !dropped.has(row.loopId)) })
  })
  ipcMain.handle('report:refresh', (_event, value: unknown) => {
    const report = ledger?.getReport(String(value))
    if (!report) return null
    // Rows whose run has since been deleted keep the numbers they were frozen
    // with, so refreshing never empties a report.
    const fresh = new Map(reportRowsFor(report.rows.map((row) => row.loopId)).map((row) => [row.loopId, row]))
    return touchReport(report, {
      capturedAt: new Date().toISOString(),
      rows: report.rows.map((row) => fresh.get(row.loopId) ?? row),
    })
  })
  ipcMain.handle('report:delete', (_event, value: unknown) => ledger?.deleteReport(String(value)) ?? false)
  ipcMain.handle('report:markdown', (_event, value: unknown) => {
    const report = ledger?.getReport(String(value))
    return report ? renderReportMarkdown(report) : ''
  })
  ipcMain.handle('report:export-json', async (_event, value: unknown) => {
    try {
      const report = ledger?.getReport(String(value))
      if (!report) return { ok: false, error: 'Report not found.' }
      const body = JSON.stringify(toReportFile(report, new Date().toISOString()), null, 2)
      return await saveReportFile(report, REPORT_FILE_SUFFIX, body, 'Export report for a teammate')
    } catch (error) {
      return { ok: false, error: `Could not export report: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
  ipcMain.handle('report:export-markdown', async (_event, value: unknown) => {
    try {
      const report = ledger?.getReport(String(value))
      if (!report) return { ok: false, error: 'Report not found.' }
      return await saveReportFile(report, '.md', renderReportMarkdown(report), 'Save report as Markdown')
    } catch (error) {
      return { ok: false, error: `Could not save report: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
  ipcMain.handle('report:import', async () => {
    try {
      if (!mainWindow || !ledger) return { ok: false, error: 'Report import is not ready.' }
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Open a report a teammate sent you',
        buttonLabel: 'Open report',
        filters: [{ name: 'Gauntlet Loop report', extensions: ['json'] }],
        properties: ['openFile'],
      })
      const filePath = picked.filePaths[0]
      if (picked.canceled || !filePath) return { ok: false, canceled: true }
      const parsed = parseReportFile(await fs.readFile(filePath, 'utf8'))
      const stamp = new Date().toISOString()
      // A fresh id every time, so an imported copy never overwrites a report
      // already on this machine.
      const report = ledger.saveReport({ ...parsed, id: crypto.randomUUID(), updatedAt: stamp })
      return { ok: true, report, filePath }
    } catch (error) {
      return { ok: false, error: `Could not import report: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
}

if (hasSingleInstanceLock) {
  void app.whenReady().then(() => {
    ledger = new Ledger(path.join(app.getPath('userData'), 'ledger.db'))
    loopRunner = new LoopRunner(ledger, (channel, payload) => mainWindow?.webContents.send(channel, payload))
    void startMediaServer((loopId) => ledger?.getLoop(loopId)?.workspaceDir ?? null).then((base) => {
      mediaBase = base
    })
    registerIpc()
    registerLoopIpc()
    registerReportIpc()
    mainWindow = createWindow()
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
app.on('before-quit', (event) => {
  stopAllLogins()
  stopAllPlay()
  const active = loopRunner?.activeRun()
  if (!active) return
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Keep agents running', 'Stop agents, then quit', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: `A loop is running (${active.role}, pid ${active.pid}).`,
    detail:
      'Agents are detached: quitting keeps them working headless and the app re-attaches on the next launch (the loop advances to its next run only while the app is open). Or stop them gracefully (SIGINT) and end the loop now.',
  })
  if (choice === 2) {
    event.preventDefault()
    return
  }
  if (choice === 1) loopRunner?.stopForQuit()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
