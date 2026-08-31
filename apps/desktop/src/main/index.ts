import { spawn } from 'node:child_process'
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
import type { CritiqueRound, StartLoopInput } from '../shared/loop'
import { cliHome, subscriptionEnv } from './harness-env'
import { Ledger } from './ledger'
import { LoopRunner } from './loop-runner'
import { startMediaServer } from './media-server'
import { playState, startPlay, stopAllPlay, stopPlay } from './play'
import { buildReport, scanCritiqueArtifacts } from './report'

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
    const [claudeStatus, codexStatus] = await Promise.all([probe('claude'), probe('codex')])
    if (!claudeStatus.loggedIn) return { ok: false, error: 'Claude Code (implementer) is not connected. Sign in on the Agents tab.' }
    if (!codexStatus.loggedIn) return { ok: false, error: 'Codex (critic) is not connected. Sign in on the Agents tab.' }
    return loopRunner.start({
      prompt: String(input?.prompt ?? ''),
      workspaceDir: String(input?.workspaceDir ?? ''),
      maxRounds: Number(input?.maxRounds ?? 10),
      budgetUsd: input?.budgetUsd == null ? null : Number(input.budgetUsd) || null,
    })
  })
  ipcMain.handle('loop:resume', (_event, value: unknown) => loopRunner?.resumeLoop(String(value)) ?? { ok: false, error: 'Loop runner not ready.' })
  ipcMain.handle('loop:stop', (_event, value: unknown) => loopRunner?.stop(String(value)))
  ipcMain.handle('loop:active', () => loopRunner?.snapshot() ?? null)
  ipcMain.handle('loop:log', (_event, loopId: unknown, limit: unknown) =>
    ledger?.eventsForLoop(String(loopId), Math.min(2000, Math.max(1, Number(limit) || 800))) ?? [],
  )
  ipcMain.handle('loop:report', (_event, value: unknown) => {
    const loop = ledger?.getLoop(String(value))
    return loop && ledger ? buildReport(loop, ledger.runsForLoop(loop.id), scanCritiqueArtifacts(loop.workspaceDir)) : ''
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
  ipcMain.handle('play:start', (_event, value: unknown) => {
    const loop = ledger?.getLoop(String(value))
    if (!loop) return { running: false, url: null, error: 'Loop not found.' }
    return startPlay(loop.id, loop.workspaceDir, (state) => mainWindow?.webContents.send('play:state', state))
  })
  ipcMain.handle('play:stop', (_event, value: unknown) => {
    stopPlay(String(value))
    mainWindow?.webContents.send('play:state', { loopId: String(value), running: false, url: null, error: null })
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
if (!hasSingleInstanceLock) app.quit()

if (hasSingleInstanceLock) {
  void app.whenReady().then(() => {
    ledger = new Ledger(path.join(app.getPath('userData'), 'ledger.db'))
    loopRunner = new LoopRunner(ledger, (channel, payload) => mainWindow?.webContents.send(channel, payload))
    void startMediaServer((loopId) => ledger?.getLoop(loopId)?.workspaceDir ?? null).then((base) => {
      mediaBase = base
    })
    registerIpc()
    registerLoopIpc()
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
