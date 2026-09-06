import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import type { LoopRecord, PlayState, PlayStateEvent } from '../shared/loop'
import { redactedErrorMessage } from '../shared/redact-log'
import { sanitizedExecutablePath } from './harness-env'
import { cleanupRoundCheckout } from './round-revision'
import { safePid } from './run-process'
import { safeWorkspaceMetadataDir } from './workspace-metadata'
import { readExactFileDescriptor } from './bounded-fd'
import { assertLoopWorkspaceIdentity, type WorkspaceRootIdentity } from './workspace-boundary'

export const PLAY_TIMEOUT_MS = 4 * 60 * 60_000
const PACKAGE_JSON_LIMIT = 1024 * 1024

interface PlayRuntime {
  spawn: typeof spawn
  openExternal(url: string): Promise<void>
  kill(pid: number, signal: NodeJS.Signals): void
  groupIdentity(groupId: number): readonly string[]
  groupAlive(groupId: number, identity: readonly string[]): boolean
  setTimer(callback: () => void, timeoutMs: number): NodeJS.Timeout
  clearTimer(timer: NodeJS.Timeout): void
  setInterval(callback: () => void, intervalMs: number): NodeJS.Timeout
  clearInterval(timer: NodeJS.Timeout): void
  timeoutMs: number
}

/** Capture stable member identities before signaling a detached process group. */
export function processGroupIdentity(groupId: number): string[] {
  if (!safePid(groupId)) throw new Error('Process-group identity probe requires a safe group id.')
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,lstart='], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 1_000,
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    throw new Error('Process-group identity probe failed; group absence is unknown.')
  }
  const identities: string[] = []
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (!match || Number(match[2]) !== groupId) continue
    const pid = Number(match[1])
    if (safePid(pid)) identities.push(`${pid}:${match[3]}`)
  }
  return identities.sort()
}

export function processGroupStillOwned(groupId: number, identity: readonly string[]): boolean {
  return processGroupIdentitiesOverlap(identity, processGroupIdentity(groupId))
}

export function processGroupIdentitiesOverlap(captured: readonly string[], current: readonly string[]): boolean {
  if (captured.length === 0) return false
  const currentMembers = new Set(current)
  return captured.some((member) => currentMembers.has(member))
}

const runtime: PlayRuntime = {
  spawn,
  openExternal: (url) => shell.openExternal(url),
  kill: (pid, signal) => process.kill(pid, signal),
  groupIdentity: processGroupIdentity,
  groupAlive: processGroupStillOwned,
  setTimer: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimer: (timer) => clearTimeout(timer),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (timer) => clearInterval(timer),
  timeoutMs: PLAY_TIMEOUT_MS,
}

interface PlaySession {
  child: ChildProcess
  groupIdentity: string[]
  workspaceDir: string
  cleanupDir: string | null
  gateDir: string
  gateFile: string
  gateReleased: boolean
  state: PlayState
  notify: (state: PlayStateEvent) => void
  runtime: PlayRuntime
  hardTimeout: NodeJS.Timeout
  identityTimer: NodeJS.Timeout | null
  stopTimers: NodeJS.Timeout[]
  terminating: boolean
}

const sessions = new Map<string, PlaySession>()
const settlementWaiters = new Set<() => void>()

function notifySession(loopId: string, session: PlaySession): void {
  try {
    session.notify({ loopId, ...session.state })
  } catch {
    // Renderer delivery is observational. A destroyed webContents must never
    // interrupt process signaling, state cleanup, or app-quit settlement.
  }
}

function resolveSettlementWaiters(): void {
  if (sessions.size !== 0) return
  for (const resolve of settlementWaiters) resolve()
  settlementWaiters.clear()
}

export function playState(loopId: string): PlayState {
  return sessions.get(loopId)?.state ?? { running: false, url: null, error: null, round: null }
}

/**
 * Decide whether a loop may execute Play. Agent-loop activity is deliberately
 * not a denial condition: trusted local runs may preview their live workspace
 * while agents continue editing it.
 */
export function playAccessError(loop: Pick<LoopRecord, 'playTrusted' | 'executionTrusted' | 'status'>): string | null {
  return loop.playTrusted || loop.executionTrusted
    ? null
    : 'Untrusted history (imported or created before trust provenance shipped) cannot use Play because it executes project scripts. Use Play to explicitly trust this run and folder.'
}

function cleanupCheckout(checkoutDir: string | null): string | null {
  if (!checkoutDir) return null
  try {
    cleanupRoundCheckout(checkoutDir)
    return null
  } catch (error) {
    return `Could not clean the saved-round checkout: ${redactedErrorMessage(error, 'Unknown cleanup failure.')}`
  }
}

function cleanup(session: PlaySession): string | null {
  session.runtime.clearTimer(session.hardTimeout)
  if (session.identityTimer) session.runtime.clearInterval(session.identityTimer)
  for (const timer of session.stopTimers) session.runtime.clearTimer(timer)
  session.stopTimers = []
  let gateError: string | null = null
  try {
    fs.unlinkSync(session.gateFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      gateError = `Could not remove the Play launch gate: ${redactedErrorMessage(error, 'Unknown gate cleanup failure.')}`
    }
  }
  try {
    fs.rmdirSync(session.gateDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      gateError ??= `Could not remove the Play launch gate directory: ${redactedErrorMessage(error, 'Unknown gate cleanup failure.')}`
    }
  }
  const checkoutDir = session.cleanupDir
  session.cleanupDir = null
  return [gateError, cleanupCheckout(checkoutDir)].filter(Boolean).join(' ') || null
}

function mergeVerifiedGroupIdentity(session: PlaySession): 'absent' | 'owned' | 'unrelated' | 'unknown' {
  const pid = session.child.pid
  if (!safePid(pid) || session.groupIdentity.length === 0) return 'absent'
  let current: readonly string[]
  try {
    current = session.runtime.groupIdentity(pid)
  } catch {
    return 'unknown'
  }
  if (current.length === 0) return 'absent'
  // Exact overlap is the only continuity proof. Even an exact ChildProcess
  // exit notification does not authorize adopting a fresh process that has
  // already reused the numeric PGID.
  if (!processGroupIdentitiesOverlap(session.groupIdentity, current)) return 'unrelated'
  const known = new Set(session.groupIdentity)
  for (const identity of current) known.add(identity)
  session.groupIdentity.splice(0, session.groupIdentity.length, ...[...known].sort(compareIdentity))
  return 'owned'
}

function compareIdentity(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function openSessionUrl(loopId: string, session: PlaySession, url: string): void {
  void session.runtime.openExternal(url).catch((error: unknown) => {
    if (sessions.get(loopId)?.child !== session.child) return
    session.state = {
      ...session.state,
      error: `Game is running, but its URL could not be opened: ${redactedErrorMessage(error, 'Unknown browser failure.')}`,
    }
    notifySession(loopId, session)
  })
}

function scheduleSessionTimer(session: PlaySession, callback: () => void, delayMs: number): NodeJS.Timeout {
  let timer: NodeJS.Timeout
  timer = session.runtime.setTimer(() => {
    const index = session.stopTimers.indexOf(timer)
    if (index >= 0) session.stopTimers.splice(index, 1)
    callback()
  }, delayMs)
  timer.unref?.()
  session.stopTimers.push(timer)
  return timer
}

function checkedGroupAlive(session: PlaySession, pid: number, identity: readonly string[]): boolean | null {
  try {
    return session.runtime.groupAlive(pid, identity)
  } catch {
    return null
  }
}

function noteUnknownGroupProbe(loopId: string, session: PlaySession): void {
  session.state = {
    ...session.state,
    running: true,
    url: null,
    error: 'Play process-group ownership could not be checked. Gauntlet Loop will not signal or unblock a possibly live group; it will retry until absence is verified.',
  }
  notifySession(loopId, session)
}

function signalProcessGroup(loopId: string, session: PlaySession, afterGroupExit?: () => void): void {
  const pid = session.child.pid
  if (!safePid(pid)) return
  const identity = session.groupIdentity
  const watchForExit = (): void => {
    if (!afterGroupExit || sessions.get(loopId) !== session) return
    scheduleSessionTimer(session, () => {
      if (sessions.get(loopId) !== session) return
      const alive = checkedGroupAlive(session, pid, identity)
      if (alive === false) afterGroupExit()
      else {
        if (alive === null) noteUnknownGroupProbe(loopId, session)
        watchForExit()
      }
    }, 1_000)
  }
  // The numeric pid/pgid may have been reused after a fast leader exit. Only
  // signal while at least one exact member captured at launch still exists.
  const initiallyAlive = checkedGroupAlive(session, pid, identity)
  if (initiallyAlive !== true) {
    if (initiallyAlive === null) {
      noteUnknownGroupProbe(loopId, session)
      watchForExit()
      return
    }
    afterGroupExit?.()
    return
  }
  try {
    session.runtime.kill(-pid, 'SIGINT')
  } catch {
    // Still schedule the identity-checked escalation. A failed SIGINT does
    // not prove the verified process group has exited.
  }
  for (const [delay, signal] of [[6_000, 'SIGKILL']] as const) {
    scheduleSessionTimer(session, () => {
      // The npm leader can exit before its game-server descendants. A live
      // original process group retains its pgid, while a gone group must not
      // receive a delayed signal after that numeric id becomes reusable.
      const alive = checkedGroupAlive(session, pid, identity)
      if (alive !== true) {
        if (alive === null) {
          noteUnknownGroupProbe(loopId, session)
          watchForExit()
          return
        }
        afterGroupExit?.()
        return
      }
      try {
        session.runtime.kill(-pid, signal)
      } catch {
        /* already gone */
      }
      if (afterGroupExit) {
        scheduleSessionTimer(session, () => {
          const settledAlive = checkedGroupAlive(session, pid, identity)
          if (settledAlive !== true) {
            if (settledAlive === null) {
              noteUnknownGroupProbe(loopId, session)
              watchForExit()
              return
            }
            afterGroupExit()
            return
          }
          session.state = {
            ...session.state,
            error: 'The game launcher exited, but its verified background process group survived SIGKILL. Play and Export remain blocked; stop that process manually.',
          }
          notifySession(loopId, session)
          watchForExit()
        }, 250)
      }
    }, delay)
  }
}

function finishPlaySession(loopId: string, session: PlaySession, error: string | null): void {
  if (sessions.get(loopId) !== session) return
  sessions.delete(loopId)
  const cleanupError = cleanup(session)
  session.state = {
    running: false,
    url: null,
    error: [error, cleanupError].filter(Boolean).join(' ') || null,
    round: session.state.round,
  }
  try {
    notifySession(loopId, session)
  } finally {
    resolveSettlementWaiters()
  }
}

function stopVerifiedSession(loopId: string, session: PlaySession, pendingMessage: string, finalError: string | null): void {
  if (session.terminating) return
  session.terminating = true
  session.state = { ...session.state, running: true, url: null, error: pendingMessage }
  notifySession(loopId, session)
  signalProcessGroup(loopId, session, () => finishPlaySession(loopId, session, finalError))
}

function retainUnrelatedGroup(loopId: string, session: PlaySession, finalError: string | null): void {
  if (session.terminating) return
  session.terminating = true
  session.runtime.clearTimer(session.hardTimeout)
  session.state = {
    ...session.state,
    running: true,
    url: null,
    error: 'The game launcher exited but its numeric process group could not be tied to any exact owned member. Gauntlet Loop will not signal a possibly unrelated group; Play, Export, and app quit remain blocked until the numeric group is verified absent.',
  }
  notifySession(loopId, session)
  const poll = (): void => {
    scheduleSessionTimer(session, () => {
      if (sessions.get(loopId) !== session) return
      const pid = session.child.pid
      try {
        const current = safePid(pid) ? session.runtime.groupIdentity(pid) : []
        if (current.length === 0) finishPlaySession(loopId, session, finalError)
        else poll()
      } catch {
        poll()
      }
    }, 1_000)
  }
  poll()
}

export function stopPlay(loopId: string): void {
  const session = sessions.get(loopId)
  if (!session) return
  if (session.groupIdentity.length === 0) {
    session.state = {
      ...session.state,
      error: 'Game process ownership could not be verified, so the protected launch gate did not release the project script. Gauntlet Loop is stopping the app-owned wrapper; Play and Export remain blocked until it exits.',
    }
    notifySession(loopId, session)
    try {
      session.child.kill('SIGINT')
    } catch {
      /* the retained forced-stop timer and exit handler remain authoritative */
    }
    return
  }
  stopVerifiedSession(loopId, session, 'Stopping the verified game process group…', null)
}

export function stopAllPlay(): void {
  for (const loopId of [...sessions.keys()]) stopPlay(loopId)
}

export function hasActivePlay(): boolean {
  return sessions.size > 0
}

/** Keep Electron alive until every supervised Play group/wrapper is gone. */
export function stopAllPlayAndWait(): Promise<void> {
  stopAllPlay()
  if (sessions.size === 0) return Promise.resolve()
  return new Promise((resolve) => settlementWaiters.add(resolve))
}

function readBoundedText(file: string, limit: number): string {
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error(`${path.basename(file)} must be a bounded unlinked regular file.`)
    return readExactFileDescriptor(descriptor, stat.size, limit, path.basename(file)).toString('utf8')
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

export function detectLaunch(workspaceDir: string): { command: string; args: string[] } | { error: string } {
  try {
    const parsed = JSON.parse(readBoundedText(path.join(workspaceDir, 'package.json'), PACKAGE_JSON_LIMIT)) as unknown
    const pkg = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    const scripts = pkg?.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
      ? (pkg.scripts as Record<string, unknown>)
      : null
    for (const script of ['dev', 'start', 'serve', 'preview']) {
      if (typeof scripts?.[script] === 'string' && scripts[script].length > 0) return { command: 'npm', args: ['run', script] }
    }
  } catch {
    /* no valid package.json — fall through */
  }
  if (fs.existsSync(path.join(workspaceDir, 'index.html'))) {
    return { error: 'This project has index.html but no launch script. Add a dev/start/serve/preview script after installing its dependencies; Play never downloads executables automatically.' }
  }
  return { error: 'Nothing launchable yet — no dev/start/serve/preview script in package.json.' }
}

/**
 * Minimal environment for agent-authored game scripts; no shell credentials and
 * no user npm config.
 *
 * `HOME` is passed through rather than redirected. Rewriting it hid the user's
 * dotfiles from convention-following code, but Node version managers are
 * convention-following code too: volta, asdf and mise all resolve their
 * toolchain from `$HOME`, so a redirected home hid the user's Node along with
 * their secrets. A real run failed with exit 126 and `Volta error: Node is not
 * available` — Play worked only for operators whose `npm` was a real binary
 * rather than a shim.
 *
 * What the redirect actually bought is kept by narrower means: the two
 * `NPM_CONFIG_*` variables still point into the workspace, so `~/.npmrc` and
 * its registry tokens are ignored and nothing the game installs touches the
 * user's npm cache. The allowlist still drops credentials and `NODE_OPTIONS`.
 * The rest was never a real barrier — the script runs as the user and can read
 * any absolute path (DECISIONS: "same-user filesystem permissions are not
 * claimed as a technical read barrier").
 */
export function playEnvironment(workspaceDir: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home = safeWorkspaceMetadataDir(workspaceDir, ['play-home'], true)
  fs.chmodSync(home, 0o700)
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
      .map((key) => [key, source[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const safePath = sanitizedExecutablePath(env.PATH, [workspaceDir, home])
  if (safePath) env.PATH = safePath
  else delete env.PATH
  return {
    ...env,
    NPM_CONFIG_USERCONFIG: path.join(home, 'npmrc'),
    NPM_CONFIG_CACHE: path.join(home, 'npm-cache'),
    BROWSER: 'none',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  }
}

export function startPlay(
  loopId: string,
  workspaceDir: string,
  round: number | null,
  cleanupDir: string | null,
  notify: (state: PlayStateEvent) => void,
  overrides: Partial<PlayRuntime> = {},
  boundary?: { expectedWorkspace: WorkspaceRootIdentity; protectedRoots: readonly string[] },
): PlayState {
  const existing = sessions.get(loopId)
  const activeRuntime = { ...runtime, ...overrides }
  if (existing?.state.running && existing.workspaceDir === workspaceDir) {
    if (existing.state.url) openSessionUrl(loopId, existing, existing.state.url)
    return existing.state
  }
  if (existing) {
    stopPlay(loopId)
    const stopping = sessions.get(loopId)
    if (stopping) return stopping.state
  }
  const assertExpectedWorkspace = (): void => {
    if (!boundary) return
    const verified = assertLoopWorkspaceIdentity(boundary.expectedWorkspace, boundary.protectedRoots)
    if (verified !== path.resolve(workspaceDir)) throw new Error('Play root does not match the registered workspace identity.')
  }
  try {
    assertExpectedWorkspace()
  } catch (error) {
    const cleanupError = cleanupCheckout(cleanupDir)
    const message = `Play is blocked because the workspace root changed: ${redactedErrorMessage(error, 'Workspace identity check failed.')}`
    return { running: false, url: null, error: cleanupError ? `${message} ${cleanupError}` : message, round }
  }
  const launch = detectLaunch(workspaceDir)
  assertExpectedWorkspace()
  if ('error' in launch) {
    const cleanupError = cleanupCheckout(cleanupDir)
    return { running: false, url: null, error: cleanupError ? `${launch.error} ${cleanupError}` : launch.error, round }
  }

  // The workspace command cannot run until main has captured the exact
  // identity of this fixed app-controlled wrapper. Renderer/workspace data is
  // passed only as positional argv; the shell program itself is constant.
  let gateDir: string | null = null
  let child: ChildProcess
  try {
    assertExpectedWorkspace()
    gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-play-gate-'))
    fs.chmodSync(gateDir, 0o700)
    const gateFile = path.join(gateDir, 'release')
    const env = playEnvironment(workspaceDir)
    assertExpectedWorkspace()
    child = activeRuntime.spawn('/bin/sh', [
      '-c',
      'while [ ! -f "$1" ]; do /bin/sleep 0.01; done; shift; exec "$@"',
      'gauntlet-play-gate',
      gateFile,
      launch.command,
      ...launch.args,
    ], {
      cwd: workspaceDir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (gateDir) fs.rmdirSync(gateDir)
    const cleanupError = cleanupCheckout(cleanupDir)
    const message = `Could not start game process: ${redactedErrorMessage(error, 'Unknown spawn failure.')}`
    const state = { running: false, url: null, error: cleanupError ? `${message} ${cleanupError}` : message, round }
    try {
      notify({ loopId, ...state })
    } catch {
      /* renderer notification cannot turn a handled spawn failure into a crash */
    }
    return state
  }
  // Native spawn failures can return a ChildProcess without a PID and emit an
  // asynchronous error later. Install a listener before every early return so
  // such an event cannot crash the Electron main process.
  child.on('error', () => undefined)
  const childPid = child.pid
  const pidIsSafe = safePid(childPid)
  let groupIdentity: readonly string[] = []
  if (pidIsSafe) {
    try {
      groupIdentity = activeRuntime.groupIdentity(childPid)
    } catch {
      // The private gate remains closed and the direct wrapper handle is
      // supervised below; a failed identity probe must never release code.
    }
  }
  const ownershipVerified = pidIsSafe
    && child.exitCode == null
    && child.signalCode == null
    && groupIdentity.some((member) => member.startsWith(`${child.pid}:`))
  const session: PlaySession = {
    child,
    groupIdentity: [...groupIdentity],
    workspaceDir,
    cleanupDir,
    gateDir,
    gateFile: path.join(gateDir, 'release'),
    gateReleased: false,
    state: {
      running: true,
      url: null,
      error: ownershipVerified
        ? null
        : pidIsSafe
          ? 'The protected Play wrapper launched, but its process ownership could not be verified. The project script was not released; Gauntlet Loop is stopping and supervising the wrapper without signaling a numeric PID.'
          : 'The protected Play wrapper launched without a safe PID. The project script was not released; Gauntlet Loop is stopping and supervising the directly returned child handle until it exits.',
      round,
    },
    notify,
    runtime: activeRuntime,
    hardTimeout: undefined as unknown as NodeJS.Timeout,
    identityTimer: null,
    stopTimers: [],
    terminating: false,
  }
  const push = (): void => notifySession(loopId, session)
  session.hardTimeout = activeRuntime.setTimer(() => {
    if (sessions.get(loopId)?.child !== child) return
    if (!ownershipVerified) {
      session.state = {
        ...session.state,
        error: `Game exceeded the ${Math.round(activeRuntime.timeoutMs / 60_000)} minute safety timeout, but ownership could not be verified. Stop it manually; Play and Export remain blocked until it exits.`,
      }
      push()
      return
    }
    stopVerifiedSession(
      loopId,
      session,
      `Game exceeded the ${Math.round(activeRuntime.timeoutMs / 60_000)} minute safety timeout; stopping its verified process group…`,
      `Game process stopped after the ${Math.round(activeRuntime.timeoutMs / 60_000)} minute safety timeout.`,
    )
  }, activeRuntime.timeoutMs)
  session.hardTimeout.unref?.()
  sessions.set(loopId, session)
  if (ownershipVerified) {
    session.identityTimer = activeRuntime.setInterval(() => {
      if (sessions.get(loopId) === session) mergeVerifiedGroupIdentity(session)
    }, 1_000)
    session.identityTimer.unref?.()
  }

  let buffer = ''
  const scan = (chunk: Buffer): void => {
    if (ownershipVerified) mergeVerifiedGroupIdentity(session)
    if (session.state.url) return
    buffer = (buffer + chunk.toString()).slice(-8_000)
    const match = buffer.replace(/\u001b\[[0-9;]*m/g, '').match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/)
    if (match) {
      const browserUrl = new URL(match[0])
      if (round != null) browserUrl.searchParams.set('gauntlet-round', String(round))
      session.state.url = browserUrl.toString()
      openSessionUrl(loopId, session, session.state.url)
      push()
    }
  }
  child.stdout?.on('data', scan)
  child.stderr?.on('data', scan)
  child.on('exit', (code) => {
    if (sessions.get(loopId)?.child !== child) return
    const finish = (): void => finishPlaySession(loopId, session, code ? `Game process exited (code ${code}).` : null)
    // A Stop/timeout shutdown already owns the verified group and its
    // escalation timers; the leader's exit must not cancel or duplicate it.
    if (session.terminating) return
    const finalGroup = ownershipVerified ? mergeVerifiedGroupIdentity(session) : 'absent'
    if (ownershipVerified && (finalGroup === 'unrelated' || finalGroup === 'unknown')) {
      retainUnrelatedGroup(loopId, session, code ? `Game process exited (code ${code}).` : null)
      return
    }
    if (finalGroup === 'owned') {
      stopVerifiedSession(
        loopId,
        session,
        'The game launcher exited while a verified background server was still running. Gauntlet Loop is stopping that process group.',
        code ? `Game process exited (code ${code}).` : null,
      )
      return
    }
    finish()
  })
  child.on('error', (error) => {
    if (sessions.get(loopId)?.child !== child) return
    if (session.terminating) return
    const failure = redactedErrorMessage(error, 'Game process failed.')
    const finalGroup = ownershipVerified ? mergeVerifiedGroupIdentity(session) : 'absent'
    if (ownershipVerified && (finalGroup === 'unrelated' || finalGroup === 'unknown')) {
      retainUnrelatedGroup(loopId, session, failure)
      return
    }
    if (finalGroup === 'owned') {
      stopVerifiedSession(
        loopId,
        session,
        `The game launcher failed while a verified background server was still running. Gauntlet Loop is stopping that process group. ${failure}`,
        failure,
      )
      return
    }
    finishPlaySession(loopId, session, failure)
  })
  if (!ownershipVerified) {
    // The freshly returned ChildProcess handle is the only ownership evidence
    // available when /bin/ps cannot capture the detached group. Interrupt that
    // direct child immediately; never use the unverified numeric pgid.
    try {
      child.kill('SIGINT')
    } catch {
      /* the exit/error handlers still supervise the returned child */
    }
    scheduleSessionTimer(session, () => {
      if (sessions.get(loopId)?.child !== child || child.exitCode != null || child.signalCode != null) return
      try {
        child.kill('SIGKILL')
      } catch {
        /* the child may have exited before delivery */
      }
    }, 6_000)
  } else {
    try {
      assertExpectedWorkspace()
      fs.writeFileSync(session.gateFile, '', { flag: 'wx', mode: 0o600 })
      session.gateReleased = true
    } catch (error) {
      stopVerifiedSession(
        loopId,
        session,
        `The protected Play launch gate could not be released; stopping its verified wrapper. ${redactedErrorMessage(error, 'Unknown gate failure.')}`,
        'The game project was not started because its protected launch gate failed.',
      )
    }
  }
  push()
  return session.state
}
