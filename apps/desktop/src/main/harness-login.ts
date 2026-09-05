import { spawn } from 'node:child_process'
import pty, { type IPty } from 'node-pty'
import type { DetectionResult, HarnessAction, HarnessKind, InstallOffer, LogoutResult, ProbeResult } from '../shared/harness'
import { redactLogText, redactedErrorMessage } from '../shared/redact-log'
import { cliExecutable } from './cli-executable'
import { cliHome, cliHomeEnv, cliPrivateRoot, subscriptionEnv } from './harness-env'
import { installEnv, installPlan } from './harness-install'
import { parseClaudeStatus, parseCodexStatus, parseUrls, stripAnsi } from './harness-status'

interface HarnessSpec {
  kind: HarnessKind
  home: string
  command: string
  versionArgs: string[]
  statusArgs: string[]
  loginArgs: string[]
  logoutArgs: string[]
  env: Record<string, string>
}

interface CommandResult {
  ok: boolean
  code?: number | null
  stdout: string
  stderr: string
  error?: string
}

interface HarnessLoginEvents {
  action(kind: HarnessKind, action: HarnessAction): void
  terminal(kind: HarnessKind, data: string): void
}

interface HarnessLoginDependencies {
  spawnCommand?: typeof spawn
  spawnPty?: typeof pty.spawn
  cliHome?: typeof cliHome
  env?: typeof subscriptionEnv
  cliExecutable?: typeof cliExecutable
  retryDelayMs?: number
}

const OUTPUT_LIMIT = 64 * 1024

/** Owns CLI detection, status probing, and the complete interactive login lifecycle. */
export class HarnessLoginManager {
  private readonly running = new Map<HarnessKind, IPty>()
  private readonly spawnCommand: typeof spawn
  private readonly spawnPty: typeof pty.spawn
  private readonly resolveCliHome: typeof cliHome
  private readonly makeEnv: typeof subscriptionEnv
  private readonly resolveExecutable: typeof cliExecutable
  private readonly retryDelayMs: number

  constructor(
    private readonly homeDir: string,
    private readonly events: HarnessLoginEvents,
    dependencies: HarnessLoginDependencies = {},
  ) {
    this.spawnCommand = dependencies.spawnCommand ?? spawn
    this.spawnPty = dependencies.spawnPty ?? pty.spawn
    this.resolveCliHome = dependencies.cliHome ?? cliHome
    this.makeEnv = dependencies.env ?? subscriptionEnv
    this.resolveExecutable = dependencies.cliExecutable ?? cliExecutable
    this.retryDelayMs = dependencies.retryDelayMs ?? 250
  }

  private spec(kind: HarnessKind, home = this.resolveCliHome(kind)): HarnessSpec {
    if (kind === 'claude') {
      return {
        kind,
        home,
        command: 'claude',
        versionArgs: ['--version'],
        statusArgs: ['auth', 'status', '--json'],
        loginArgs: ['auth', 'login', '--claudeai'],
        logoutArgs: ['auth', 'logout'],
        env: cliHomeEnv(kind, home),
      }
    }
    return {
      kind,
      home,
      command: 'codex',
      versionArgs: ['--version'],
      statusArgs: ['login', 'status'],
      loginArgs: ['login'],
      logoutArgs: ['logout'],
      env: cliHomeEnv(kind, home),
    }
  }

  private executableUnsafeRoots(home: string): string[] {
    return [cliPrivateRoot(home)]
  }

  private command(spec: HarnessSpec, args: string[], timeoutMs = 8_000): Promise<CommandResult> {
    return new Promise((resolve) => {
      let child
      try {
        const executable = this.resolveExecutable(spec.kind, this.executableUnsafeRoots(spec.home))
        child = this.spawnCommand(executable, args, {
          cwd: this.homeDir,
          env: this.makeEnv(spec.env, process.env, spec.kind, [spec.home]),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        resolve({ ok: false, stdout: '', stderr: '', error: redactedErrorMessage(error, 'Unable to start the command.') })
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      let closed = false
      let escalation: NodeJS.Timeout | null = null
      const finish = (result: CommandResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      child.stdout.on('data', (chunk: Buffer) => (stdout = `${stdout}${chunk.toString()}`.slice(-OUTPUT_LIMIT)))
      child.stderr.on('data', (chunk: Buffer) => (stderr = `${stderr}${chunk.toString()}`.slice(-OUTPUT_LIMIT)))
      child.on('error', (error) => {
        closed = true
        if (escalation) clearTimeout(escalation)
        finish({ ok: false, stdout, stderr, error: redactedErrorMessage(error, 'Command failed.') })
      })
      child.on('close', (code) => {
        closed = true
        if (escalation) clearTimeout(escalation)
        finish({ ok: code === 0, code, stdout, stderr })
      })
      const timer = setTimeout(() => {
        try {
          child.kill('SIGINT')
        } catch {
          /* an already-exited probe will deliver close/error */
        }
        escalation = setTimeout(() => {
          if (closed) return
          try {
            child.kill('SIGKILL')
          } catch {
            /* process is already gone */
          }
        }, 3_000)
        escalation.unref()
        finish({ ok: false, stdout, stderr, error: 'Command timed out.' })
      }, timeoutMs)
      timer.unref()
    })
  }

  async detect(kind: HarnessKind, home?: string): Promise<DetectionResult> {
    const spec = this.spec(kind, home)
    const result = await this.command(spec, spec.versionArgs)
    const versionText = stripAnsi(result.stdout || result.stderr).trim().split('\n')[0] ?? ''
    const version = versionText ? redactLogText(versionText).slice(0, 500) : null
    return {
      found: result.ok,
      version,
      error: result.ok ? null : redactedErrorMessage(result.error ?? result.stderr, 'CLI detection failed.'),
    }
  }

  async probe(kind: HarnessKind, home?: string): Promise<ProbeResult> {
    const spec = this.spec(kind, home)
    const [result, detection] = await Promise.all([
      this.command(spec, spec.statusArgs),
      this.detect(kind, home),
    ])
    return kind === 'claude'
      ? parseClaudeStatus(result.stdout, result.stderr, detection.version)
      : parseCodexStatus(result.ok, result.stdout, result.stderr, detection.version)
  }

  private async verify(kind: HarnessKind): Promise<ProbeResult> {
    let status: ProbeResult = { loggedIn: false }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      status = await this.probe(kind)
      if (status.loggedIn) return status
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
    }
    return status
  }

  start(kind: HarnessKind): void {
    if (this.running.has(kind)) return
    const spec = this.spec(kind)
    let child: IPty
    try {
      const executable = this.resolveExecutable(kind, this.executableUnsafeRoots(spec.home))
      child = this.spawnPty(executable, spec.loginArgs, {
        name: 'xterm-256color',
        cols: 100,
        rows: 22,
        cwd: this.homeDir,
        env: this.makeEnv(spec.env, process.env, kind, [spec.home]),
      })
    } catch (error) {
      this.events.action(kind, {
        type: 'login_failed',
        error: redactedErrorMessage(error, 'Unable to start the login process.'),
      })
      return
    }

    this.running.set(kind, child)
    this.events.action(kind, { type: 'login_started' })
    let transcript = ''
    let emittedUrl: string | null = null
    child.onData((chunk) => {
      transcript = `${transcript}${chunk}`.slice(-16_000)
      this.events.terminal(kind, chunk)
      const url = parseUrls(transcript).at(-1)?.replace(/[),.;]+$/, '')
      if (url && url !== emittedUrl) {
        emittedUrl = url
        this.events.action(kind, { type: 'login_url', url })
      }
    })
    child.onExit(async ({ exitCode, signal }) => {
      this.running.delete(kind)
      if (signal || exitCode === 130 || exitCode === 143) {
        this.events.action(kind, { type: 'login_cancelled' })
        return
      }
      const status = await this.verify(kind)
      this.events.action(
        kind,
        status.loggedIn
          ? { type: 'probe_finished', ...status }
          : { type: 'login_failed', error: `Login command exited ${exitCode}, but the CLI is not signed in.` },
      )
    })
  }

  /** What the app would run to install this CLI, for the UI to show first. */
  offerInstall(kind: HarnessKind): InstallOffer {
    const plan = installPlan(kind)
    return { available: plan !== null, command: plan?.displayCommand ?? null }
  }

  /**
   * Runs the vendor's own installer in the login terminal, so the user watches
   * the same output they would see had they pasted the command themselves.
   *
   * The installer gets a plain environment with the real home — never the
   * harness environment, which points HOME and CODEX_HOME at app-private
   * directories the CLI must not be installed into.
   */
  install(kind: HarnessKind): void {
    if (this.running.has(kind)) return
    const plan = installPlan(kind)
    if (!plan) {
      this.events.action(kind, {
        type: 'install_failed',
        error: 'Installing from the app is only supported on macOS and Linux.',
      })
      return
    }

    let child: IPty
    try {
      child = this.spawnPty(plan.command, plan.args, {
        name: 'xterm-256color',
        cols: 100,
        rows: 22,
        cwd: this.homeDir,
        env: installEnv(this.homeDir, process.env),
      })
    } catch (error) {
      this.events.action(kind, {
        type: 'install_failed',
        error: redactedErrorMessage(error, 'Unable to start the installer.'),
      })
      return
    }

    this.running.set(kind, child)
    this.events.action(kind, { type: 'install_started' })
    this.events.terminal(kind, `$ ${plan.displayCommand}\r\n`)
    child.onData((chunk) => this.events.terminal(kind, chunk))
    child.onExit(async ({ exitCode, signal }) => {
      this.running.delete(kind)
      if (signal || exitCode === 130 || exitCode === 143) {
        this.events.action(kind, { type: 'install_failed', error: 'The install was stopped before it finished.' })
        return
      }
      if (exitCode !== 0) {
        this.events.action(kind, { type: 'install_failed', error: `The installer exited ${exitCode}.` })
        return
      }
      // The installer adds its directory to a shell profile, which this
      // already-running process never re-reads, so detection has to find the
      // new binary by its known install location rather than by PATH alone.
      const detection = await this.detect(kind)
      this.events.action(kind, detection.found
        ? { type: 'detected', ...detection }
        : {
            type: 'install_failed',
            error: 'The installer finished but the command is still not available. Restart the app and try again.',
          })
      if (detection.found) this.events.action(kind, { type: 'probe_finished', ...await this.probe(kind) })
    })
  }

  cancel(kind: HarnessKind): void {
    this.running.get(kind)?.kill('SIGINT')
  }

  write(kind: HarnessKind, data: string): void {
    this.running.get(kind)?.write(data)
  }

  resize(kind: HarnessKind, cols: number, rows: number): void {
    this.running.get(kind)?.resize(cols, rows)
  }

  async logout(kind: HarnessKind, home?: string): Promise<LogoutResult> {
    const spec = this.spec(kind, home)
    this.cancel(kind)
    const result = await this.command(spec, spec.logoutArgs)
    const status = await this.probe(kind, home)
    if (status.loggedIn) {
      return {
        ok: false,
        error: redactedErrorMessage(result.error ?? (result.stderr || result.stdout), 'The CLI is still signed in after the logout command.'),
      }
    }
    return { ok: true }
  }

  stopAll(): void {
    for (const child of this.running.values()) child.kill('SIGINT')
    this.running.clear()
  }
}
