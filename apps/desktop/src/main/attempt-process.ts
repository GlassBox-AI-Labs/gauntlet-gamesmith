import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isRecordId } from '../shared/record-id'
import { attemptsDir } from './harness-env'
import { readExactFileDescriptor } from './bounded-fd'
import { WORKSPACE_METADATA_DIR } from './workspace-metadata'

const META_VERSION = 1
const MAX_META_BYTES = 256 * 1024
const OFFSET_KEY = /^[a-z0-9-]+\.(?:claude|codex)\.jsonl$/
const WORKFLOW_OFFSET_KEY = /^wf_[A-Za-z0-9_-]{1,128}\/(?:journal|agent-[A-Za-z0-9_-]{1,128})\.jsonl$/
const PROCESS_LSTART = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|[12]\d|3[01]) \d{2}:\d{2}:\d{2} \d{4}$/
const MAX_GROUP_IDENTITIES = 256

export interface AttemptProcessMeta {
  version: 1
  pid: number
  processIdentity: string
  groupIdentities: string[]
  outPath: string
  errPath: string
  startedAtMs: number
  outDev: number
  outIno: number
  errDev: number
  errIno: number
  loggedOutLines: number
  loggedErrLines: number
  childOffsets?: Record<string, number>
  childIdentities?: Record<string, { dev: number; ino: number }>
  workflowOffsets?: Record<string, number>
  workflowIdentities?: Record<string, { dev: number; ino: number }>
}

export interface ProcessStreamIdentity {
  outDev: number
  outIno: number
  errDev: number
  errIno: number
}

function validGroupIdentities(value: unknown, leaderPid: number, leaderIdentity: string): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GROUP_IDENTITIES) return false
  const unique = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length > 4_112) return false
    const separator = entry.indexOf(':')
    const pidText = entry.slice(0, separator)
    const identity = entry.slice(separator + 1)
    if (separator <= 0 || !/^\d{1,10}$/.test(pidText) || !safePid(Number(pidText)) || !PROCESS_LSTART.test(identity)) return false
    unique.add(entry)
  }
  return unique.size === value.length && unique.has(`${leaderPid}:${leaderIdentity}`)
}

interface StartingProcessMeta {
  version: 1
  state: 'starting'
  outPath: string
  errPath: string
  startedAtMs: number
  workspaceDev: number
  workspaceIno: number
  runsDev: number
  runsIno: number
}

export interface ProcessMetaReadResult {
  meta: AttemptProcessMeta | null
  error: string | null
}

export function safePid(pid: unknown): pid is number {
  return Number.isSafeInteger(pid) && (pid as number) > 1 && (pid as number) <= 0x7fff_ffff
}

export function processMetaPath(workspaceDir: string, attemptId: string): string {
  if (!isRecordId(attemptId)) throw new Error('Invalid attempt id for process metadata.')
  return path.join(path.resolve(workspaceDir), WORKSPACE_METADATA_DIR, 'builds', `${attemptId}.json`)
}

function processStartingMetaPath(workspaceDir: string, attemptId: string): string {
  if (!isRecordId(attemptId)) throw new Error('Invalid attempt id for starting process metadata.')
  return path.join(path.resolve(workspaceDir), WORKSPACE_METADATA_DIR, 'builds', `${attemptId}.starting.json`)
}

export function processStreamPaths(workspaceDir: string, attemptId: string): { outPath: string; errPath: string } {
  if (!isRecordId(attemptId)) throw new Error('Invalid attempt id for process streams.')
  // Path derivation must be side-effect free. Callers validate the registered
  // workspace identity before using these names; launch creates the owned attempt
  // directory explicitly in prepareProcessMeta.
  const dir = path.join(path.resolve(workspaceDir), WORKSPACE_METADATA_DIR, 'builds')
  return { outPath: path.join(dir, `${attemptId}.out.ndjson`), errPath: path.join(dir, `${attemptId}.err.log`) }
}

function exclusiveWrite(file: string, value: unknown, assertBoundary: () => void): void {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  if (bytes.length > MAX_META_BYTES) throw new Error('Process metadata exceeds its immutable snapshot limit.')
  let fd: number | null = null
  try {
    assertBoundary()
    const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0)
    fd = fs.openSync(file, flags, 0o600)
    assertBoundary()
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1) throw new Error('Process metadata publication is not a unique regular file.')
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
    const written = fs.fstatSync(fd)
    const current = fs.lstatSync(file)
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.nlink !== 1
      || current.dev !== written.dev
      || current.ino !== written.ino
      || written.size !== bytes.length
    ) {
      throw new Error('Process metadata pathname changed during immutable publication.')
    }
    assertBoundary()
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function assertLaunchBoundary(workspaceDir: string, marker: StartingProcessMeta): void {
  const workspace = fs.lstatSync(workspaceDir)
  if (
    workspace.isSymbolicLink()
    || !workspace.isDirectory()
    || workspace.dev !== marker.workspaceDev
    || workspace.ino !== marker.workspaceIno
  ) throw new Error('Workspace root changed identity during process launch.')
  const attemptRoot = fs.lstatSync(path.dirname(marker.outPath))
  if (
    attemptRoot.isSymbolicLink()
    || !attemptRoot.isDirectory()
    || attemptRoot.dev !== marker.runsDev
    || attemptRoot.ino !== marker.runsIno
  ) throw new Error('Attempt-stream directory changed identity during process launch.')
  const expected = processStreamPaths(workspaceDir, path.basename(marker.outPath, '.out.ndjson'))
  if (marker.outPath !== expected.outPath || marker.errPath !== expected.errPath) {
    throw new Error('Process launch paths no longer match the captured workspace boundary.')
  }
}

/** Persist the known paths before a detached child can be created. */
export function prepareProcessMeta(
  workspaceDir: string,
  attemptId: string,
  startedAtMs: number,
  expectedWorkspace: { dev: number; ino: number },
): StartingProcessMeta {
  const workspace = fs.lstatSync(workspaceDir)
  if (
    workspace.isSymbolicLink()
    || !workspace.isDirectory()
    || workspace.dev !== expectedWorkspace.dev
    || workspace.ino !== expectedWorkspace.ino
  ) throw new Error('Workspace root changed identity before process launch.')
  const attemptRootPath = attemptsDir(workspaceDir, true)
  const attemptRoot = fs.lstatSync(attemptRootPath)
  if (attemptRoot.isSymbolicLink() || !attemptRoot.isDirectory()) throw new Error('Attempt-stream directory is not a real directory.')
  const paths = processStreamPaths(workspaceDir, attemptId)
  const marker: StartingProcessMeta = {
    version: META_VERSION,
    state: 'starting',
    ...paths,
    startedAtMs,
    workspaceDev: workspace.dev,
    workspaceIno: workspace.ino,
    runsDev: attemptRoot.dev,
    runsIno: attemptRoot.ino,
  }
  const assertBoundary = (): void => assertLaunchBoundary(workspaceDir, marker)
  exclusiveWrite(processStartingMetaPath(workspaceDir, attemptId), marker, assertBoundary)
  return marker
}

export interface ProcessSnapshot {
  identity: string
  groupId: number
  startedAtMs: number
}

function readProcessSnapshot(pid: number): ProcessSnapshot | null {
  if (!safePid(pid)) return null
  // OS process start time is stable across exec; command text can change while
  // a CLI launcher hands off to its real binary and would reject a valid attempt.
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 2_000,
  })
  if (result.status !== 0) return null
  const match = result.stdout.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
  if (!match || Number(match[1]) !== pid) return null
  const identity = match[3]
  const startedAtMs = Date.parse(identity)
  const groupId = Number(match[2])
  return identity.length <= 4_096 && Number.isFinite(startedAtMs) && safePid(groupId)
    ? { identity, groupId, startedAtMs }
    : null
}

export function readProcessIdentity(pid: number): string | null {
  return readProcessSnapshot(pid)?.identity ?? null
}

/** Complete the recovery record only after the PID and OS identity are known. */
export function completeProcessMeta(
  workspaceDir: string,
  attemptId: string,
  marker: StartingProcessMeta,
  pid: number,
  inspect: (pid: number) => ProcessSnapshot | null = readProcessSnapshot,
  capturedStreams?: ProcessStreamIdentity,
  capturedGroupIdentities?: readonly string[],
): AttemptProcessMeta {
  assertLaunchBoundary(workspaceDir, marker)
  if (!safePid(pid)) throw new Error('Spawned process did not provide a safe PID.')
  const snapshot = inspect(pid)
  if (!snapshot) throw new Error(`Could not establish identity for spawned pid ${pid}.`)
  if (snapshot.groupId !== pid) throw new Error(`Spawned pid ${pid} did not become its detached process-group leader.`)
  if (Math.abs(snapshot.startedAtMs - marker.startedAtMs) > 10_000) {
    throw new Error(`Spawned pid ${pid} identity does not match the launch time.`)
  }
  const streams = capturedStreams ?? (() => {
    const out = fs.lstatSync(marker.outPath)
    const err = fs.lstatSync(marker.errPath)
    if (!out.isFile() || out.isSymbolicLink() || out.nlink !== 1 || !err.isFile() || err.isSymbolicLink() || err.nlink !== 1) {
      throw new Error('Attempt streams are not singly linked regular files.')
    }
    return { outDev: out.dev, outIno: out.ino, errDev: err.dev, errIno: err.ino }
  })()
  const groupIdentities = [...(capturedGroupIdentities ?? [`${pid}:${snapshot.identity}`])]
  if (!validGroupIdentities(groupIdentities, pid, snapshot.identity)) {
    throw new Error('Spawned process group identity snapshot is invalid or missing its exact leader.')
  }
  const meta: AttemptProcessMeta = {
    version: META_VERSION,
    pid,
    processIdentity: snapshot.identity,
    groupIdentities,
    outPath: marker.outPath,
    errPath: marker.errPath,
    startedAtMs: marker.startedAtMs,
    ...streams,
    loggedOutLines: 0,
    loggedErrLines: 0,
  }
  // This is an immutable initial launch snapshot. Runtime cursors and refreshed
  // process-group membership live only in the canonical SQLite row; a mutable
  // workspace mirror cannot be updated safely in an agent-writable directory.
  exclusiveWrite(processMetaPath(workspaceDir, attemptId), meta, () => assertLaunchBoundary(workspaceDir, marker))
  return meta
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function validOffsets(value: unknown): value is Record<string, number> | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length <= 1_000 && entries.every(([key, offset]) => OFFSET_KEY.test(key) && Number.isSafeInteger(offset) && offset >= 0)
}

function validWorkflowOffsets(value: unknown): value is Record<string, number> | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length <= 1_000 && entries.every(([key, offset]) => WORKFLOW_OFFSET_KEY.test(key) && Number.isSafeInteger(offset) && offset >= 0)
}

function validStreamIdentities(
  value: unknown,
  keyPattern: RegExp,
  offsets: unknown,
): value is Record<string, { dev: number; ino: number }> | undefined {
  if (value === undefined) {
    if (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return true
    return Object.values(offsets).every((offset) => offset === 0)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return false
  const entries = Object.entries(value)
  if (entries.length > 1_000) return false
  const offsetMap = offsets as Record<string, unknown>
  if (Object.entries(offsetMap).some(([key, offset]) => offset !== 0 && !Object.hasOwn(value, key))) return false
  return entries.every(([key, identity]) => {
    if (!keyPattern.test(key) || !Object.hasOwn(offsetMap, key) || !identity || typeof identity !== 'object' || Array.isArray(identity)) return false
    const fields = identity as Record<string, unknown>
    return Object.keys(fields).length === 2
      && Number.isSafeInteger(fields.dev) && (fields.dev as number) > 0
      && Number.isSafeInteger(fields.ino) && (fields.ino as number) > 0
  })
}

/** Validate every persisted field and the real filesystem paths before use. */
export function readProcessMeta(workspaceDir: string, attemptId: string): ProcessMetaReadResult {
  try {
    attemptsDir(workspaceDir, false)
  } catch {
    return { meta: null, error: 'process metadata is missing' }
  }
  const completed = processMetaPath(workspaceDir, attemptId)
  const starting = processStartingMetaPath(workspaceDir, attemptId)
  let file = completed
  try {
    fs.lstatSync(completed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { meta: null, error: 'process metadata is unsafe or unreadable' }
    }
    file = starting
  }
  let fd: number | null = null
  let text: string
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_META_BYTES) {
      return { meta: null, error: 'process metadata is not a bounded unlinked regular file' }
    }
    text = readExactFileDescriptor(fd, stat.size, MAX_META_BYTES, 'process metadata').toString('utf8')
  } catch {
    return { meta: null, error: 'process metadata is missing' }
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { meta: null, error: 'process metadata is not valid JSON' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { meta: null, error: 'process metadata is not an object' }
  const raw = value as Record<string, unknown>
  if (raw.state === 'starting') return { meta: null, error: 'process launch did not finish recording its identity' }
  const expected = processStreamPaths(workspaceDir, attemptId)
  const loggedOutLines = raw.loggedOutLines
  const loggedErrLines = raw.loggedErrLines
  const allowedKeys = new Set(['version', 'pid', 'processIdentity', 'groupIdentities', 'outPath', 'errPath', 'startedAtMs', 'outDev', 'outIno', 'errDev', 'errIno', 'loggedOutLines', 'loggedErrLines', 'childOffsets', 'childIdentities', 'workflowOffsets', 'workflowIdentities'])
  if (
    Object.keys(raw).some((key) => !allowedKeys.has(key)) ||
    raw.version !== META_VERSION ||
    !safePid(raw.pid) ||
    typeof raw.processIdentity !== 'string' ||
    !raw.processIdentity ||
    raw.processIdentity.length > 4_096 ||
    !validGroupIdentities(raw.groupIdentities, raw.pid, raw.processIdentity) ||
    raw.outPath !== expected.outPath ||
    raw.errPath !== expected.errPath ||
    typeof raw.startedAtMs !== 'number' ||
    !Number.isFinite(raw.startedAtMs) ||
    raw.startedAtMs <= 0 ||
    raw.startedAtMs > Date.now() + 60_000 ||
    !Number.isSafeInteger(raw.outDev) || (raw.outDev as number) <= 0 ||
    !Number.isSafeInteger(raw.outIno) || (raw.outIno as number) <= 0 ||
    !Number.isSafeInteger(raw.errDev) || (raw.errDev as number) <= 0 ||
    !Number.isSafeInteger(raw.errIno) || (raw.errIno as number) <= 0 ||
    typeof loggedOutLines !== 'number' ||
    !Number.isSafeInteger(loggedOutLines) ||
    loggedOutLines < 0 ||
    typeof loggedErrLines !== 'number' ||
    !Number.isSafeInteger(loggedErrLines) ||
    loggedErrLines < 0 ||
    !validOffsets(raw.childOffsets) ||
    !validStreamIdentities(raw.childIdentities, OFFSET_KEY, raw.childOffsets) ||
    !validWorkflowOffsets(raw.workflowOffsets) ||
    !validStreamIdentities(raw.workflowIdentities, WORKFLOW_OFFSET_KEY, raw.workflowOffsets)
  ) {
    return { meta: null, error: 'process metadata failed schema or exact-path validation' }
  }
  try {
    const workspace = fs.realpathSync(workspaceDir)
    const attemptRoot = fs.realpathSync(attemptsDir(workspaceDir, false))
    const outStat = fs.lstatSync(expected.outPath)
    const errStat = fs.lstatSync(expected.errPath)
    if (outStat.isSymbolicLink() || errStat.isSymbolicLink()) {
      return { meta: null, error: 'process streams must not be symbolic links' }
    }
    const out = fs.realpathSync(expected.outPath)
    const err = fs.realpathSync(expected.errPath)
    if (!isContained(workspace, attemptRoot) || !isContained(attemptRoot, out) || !isContained(attemptRoot, err)) {
      return { meta: null, error: 'process stream paths escape the workspace attempt-stream directory' }
    }
    if (
      !outStat.isFile() || outStat.nlink !== 1 || outStat.dev !== raw.outDev || outStat.ino !== raw.outIno
      || !errStat.isFile() || errStat.nlink !== 1 || errStat.dev !== raw.errDev || errStat.ino !== raw.errIno
    ) return { meta: null, error: 'process streams changed identity or are not singly linked regular files' }
  } catch {
    return { meta: null, error: 'process stream paths could not be canonicalized' }
  }
  return { meta: raw as unknown as AttemptProcessMeta, error: null }
}

export function processMatches(meta: AttemptProcessMeta): boolean {
  return safePid(meta.pid) && readProcessIdentity(meta.pid) === meta.processIdentity
}

export function processGroupAlive(meta: AttemptProcessMeta): boolean {
  if (!processMatches(meta)) return false
  try {
    process.kill(-meta.pid, 0)
    return true
  } catch {
    return false
  }
}

export interface ProcessInterruptDeps {
  kill(pid: number, signal: 0 | NodeJS.Signals): void
  defer(work: () => void, ms: number): { unref?(): unknown }
  identityMatches(meta: AttemptProcessMeta): boolean
  groupIdentity(groupId: number): readonly string[]
  groupStillOwned(groupId: number, identity: readonly string[]): boolean
}

export type ProcessInterruptOutcome = 'gone' | 'unresolved'

export function processGroupIdentity(groupId: number): string[] {
  if (!safePid(groupId)) return []
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,lstart='], {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: 1_000,
      maxBuffer: 1024 * 1024,
    })
  } catch (error) {
    throw new Error(`Process-group identity probe failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    throw new Error(`Process-group identity probe failed${result.error ? `: ${result.error.message}` : ` with status ${String(result.status)}`}.`)
  }
  const identities: string[] = []
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (!match) throw new Error('Process-group identity probe returned malformed output.')
    if (Number(match[2]) !== groupId) continue
    const memberPid = Number(match[1])
    if (!safePid(memberPid) || !PROCESS_LSTART.test(match[3])) {
      throw new Error('Process-group identity probe returned an invalid member identity.')
    }
    identities.push(`${memberPid}:${match[3]}`)
  }
  return identities.sort()
}

export function processGroupStillOwned(groupId: number, captured: readonly string[]): boolean {
  if (captured.length === 0) return false
  const current = new Set(processGroupIdentity(groupId))
  return captured.some((identity) => current.has(identity))
}

const DEFAULT_INTERRUPT_DEPS: ProcessInterruptDeps = {
  kill: (pid, signal) => process.kill(pid, signal),
  defer: (work, ms) => setTimeout(work, ms),
  identityMatches: processMatches,
  groupIdentity: processGroupIdentity,
  groupStillOwned: processGroupStillOwned,
}

function superviseOwnedGroup(
  pid: number,
  report: (message: string) => void,
  deps: ProcessInterruptDeps,
  onSettled?: (outcome: ProcessInterruptOutcome) => void,
  requiredMemberIdentity?: string,
  capturedOverride?: readonly string[],
): void {
  let settled = false
  const settle = (outcome: ProcessInterruptOutcome): void => {
    if (settled) return
    settled = true
    onSettled?.(outcome)
  }
  let capturedIdentity: readonly string[]
  try {
    capturedIdentity = capturedOverride ?? deps.groupIdentity(pid)
  } catch (error) {
    report(`Process-group ownership could not be verified before SIGINT: ${error instanceof Error ? error.message : String(error)}`)
    settle('unresolved')
    return
  }
  const groupExists = (): boolean => {
    if (settled) return false
    try {
      deps.kill(-pid, 0)
      return true
    } catch {
      return false
    }
  }
  const ownershipState = (): 'owned' | 'absent' | 'foreign' | 'unknown' => {
    try {
      if (deps.groupStillOwned(pid, capturedIdentity)) return 'owned'
      return deps.groupIdentity(pid).length === 0 ? 'absent' : 'foreign'
    } catch (error) {
      report(`Process-group ownership probe failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'unknown'
    }
  }
  const settleWithoutSignal = (signal: NodeJS.Signals, state: 'absent' | 'foreign' | 'unknown'): void => {
    if (state === 'absent') {
      report(`${signal} skipped: no recorded member identity remains in process group ${pid}.`)
      settle('gone')
      return
    }
    report(`${signal} skipped: process group ${pid} no longer has a verifiable recorded member; ownership is retained for manual intervention.`)
    settle('unresolved')
  }
  if (capturedIdentity.length === 0 || (requiredMemberIdentity && !capturedIdentity.includes(requiredMemberIdentity))) {
    report(`SIGINT skipped: recorded leader identity is no longer a member of process group ${pid}.`)
    settle(groupExists() ? 'unresolved' : 'gone')
    return
  }
  const signal = (name: NodeJS.Signals): boolean => {
    const state = ownershipState()
    if (state !== 'owned') {
      settleWithoutSignal(name, state)
      return false
    }
    if (!groupExists()) {
      report(`${name} skipped: owned process group ${pid} is no longer alive.`)
      settle('gone')
      return false
    }
    try {
      deps.kill(-pid, name)
      report(`${name} sent to owned process group ${pid}.`)
    } catch (error) {
      report(`${name} could not be sent to process group ${pid}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }
  if (!signal('SIGINT')) return
  deps.defer(() => {
    if (settled) return
    if (!signal('SIGKILL')) return
    deps.defer(() => {
      if (settled) return
      const state = ownershipState()
      if (state === 'absent' || (state === 'owned' && !groupExists())) {
        settle('gone')
        return
      }
      if (state === 'foreign' || state === 'unknown') {
        report(`Process group ${pid} could not be verified after SIGKILL; ownership is retained for manual intervention.`)
        settle('unresolved')
        return
      }
      report(`Process group ${pid} remained alive after SIGKILL; ownership is retained for manual intervention.`)
      settle('unresolved')
    }, 1_000).unref?.()
  }, 15_000).unref?.()
}

/**
 * SIGINT an identity-verified durable group, then keep owning that PGID through
 * bounded SIGKILL escalation even if the leader exits before its descendants.
 */
export function interruptProcessGroup(
  meta: AttemptProcessMeta,
  report: (message: string) => void,
  overrides: Partial<ProcessInterruptDeps> = {},
  onSettled?: (outcome: ProcessInterruptOutcome) => void,
): void {
  const deps = { ...DEFAULT_INTERRUPT_DEPS, ...overrides }
  if (!deps.identityMatches(meta)) {
    report(`SIGINT skipped: process group ${meta.pid} is gone or its leader identity no longer belongs to this build.`)
    onSettled?.('unresolved')
    return
  }
  superviseOwnedGroup(meta.pid, report, deps, onSettled, `${meta.pid}:${meta.processIdentity}`)
}

/**
 * Supervise a PGID obtained synchronously from a just-spawned detached child.
 * This seam is only for the launch window before durable identity is complete.
 */
export function interruptNewProcessGroup(
  pid: number,
  report: (message: string) => void,
  onSettled?: (outcome: ProcessInterruptOutcome) => void,
  overrides: Partial<Omit<ProcessInterruptDeps, 'identityMatches'>> = {},
): void {
  if (!safePid(pid)) {
    report(`SIGINT skipped: spawned process did not provide a safe process group id.`)
    onSettled?.('unresolved')
    return
  }
  superviseOwnedGroup(pid, report, { ...DEFAULT_INTERRUPT_DEPS, ...overrides, identityMatches: () => true }, onSettled)
}

/**
 * Interrupt a group through identities captured while its durable leader was
 * still present. This keeps descendants owned after the leader exits without
 * trusting a later numeric PGID on its own.
 */
export function interruptCapturedProcessGroup(
  pid: number,
  capturedIdentity: readonly string[],
  report: (message: string) => void,
  onSettled?: (outcome: ProcessInterruptOutcome) => void,
  overrides: Partial<Omit<ProcessInterruptDeps, 'identityMatches'>> = {},
): void {
  if (!safePid(pid) || capturedIdentity.length === 0) {
    report('SIGINT skipped: no identity-bound process group snapshot is available.')
    onSettled?.('unresolved')
    return
  }
  superviseOwnedGroup(
    pid,
    report,
    { ...DEFAULT_INTERRUPT_DEPS, ...overrides, identityMatches: () => true },
    onSettled,
    undefined,
    capturedIdentity,
  )
}
