import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
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

app.setName('Gauntlet Loop')
app.setPath('userData', path.join(app.getPath('appData'), 'Gauntlet Loop'))

function assertHarnessKind(value: unknown): HarnessKind {
  if (typeof value !== 'string' || !validHarnessKinds.has(value)) {
    throw new Error('Unsupported harness.')
  }
  return value as HarnessKind
}

function cliHome(kind: HarnessKind): string {
  const home = path.join(app.getPath('userData'), 'harnesses', kind)
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.chmodSync(home, 0o700)
  return home
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

function subscriptionEnv(overrides: Record<string, string>): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  delete env.ANTHROPIC_API_KEY
  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY
  return { ...env, ...overrides, NO_COLOR: '1' }
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
    registerIpc()
    mainWindow = createWindow()

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

app.on('before-quit', stopAllLogins)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
