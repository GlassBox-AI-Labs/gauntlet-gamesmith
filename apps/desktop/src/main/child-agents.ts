import fs from 'node:fs'
import path from 'node:path'
import { childAgentMetricId } from '../shared/agent-id'
import type { AgentMetric, TokenTotals } from '../shared/loop'
import { isRecordId } from '../shared/record-id'
import { codexTokens, usageForThread } from './codex-usage'
import {
  MAX_CHILD_ACCOUNTING_FILE_BYTES,
  MAX_CHILD_ACCOUNTING_TOTAL_BYTES,
  MAX_CHILD_DIRECTORY_ENTRIES,
  MAX_CHILD_STREAMS,
  parseChildStreamName,
} from './child-stream-name'
import { estimateCostUsd } from './pricing'
import { RUN_METADATA_DIR } from './run-transfer'
import { readExactFileDescriptor } from './bounded-fd'
import { safeWorkspaceMetadataDir } from './workspace-metadata'
import { normalizeStreamUsage } from './streams/claude-stream'
import {
  assertLoopWorkspaceIdentity,
  captureWorkspaceIdentity,
  type WorkspaceRootIdentity,
} from './workspace-boundary'

export interface ChildStreamInventory {
  files: string[]
  overflow: boolean
}

export interface ChildStreamBoundary {
  workspaceDir: string
  workspaceDev: number
  workspaceIno: number
  dir: string
  dev: number
  ino: number
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function childStreamInventory(dir: string): ChildStreamInventory {
  const files: string[] = []
  let handle: fs.Dir | null = null
  try {
    handle = fs.opendirSync(dir)
    let exhausted = false
    for (let seen = 0; seen < MAX_CHILD_DIRECTORY_ENTRIES; seen += 1) {
      const entry = handle.readSync()
      if (!entry) {
        exhausted = true
        break
      }
      const target = path.join(dir, entry.name)
      const named = parseChildStreamName(entry.name)
      if (named) {
        const stat = fs.lstatSync(target)
        if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw new Error(`Delegated worker stream ${entry.name} is not a singly linked regular file.`)
        }
        if (stat.size > MAX_CHILD_ACCOUNTING_FILE_BYTES) {
          throw new Error(`Delegated worker stream ${entry.name} exceeds its ${MAX_CHILD_ACCOUNTING_FILE_BYTES / 1024 / 1024} MiB accounting limit.`)
        }
        if (files.length >= MAX_CHILD_STREAMS) return { files: files.sort(), overflow: true }
        files.push(entry.name)
        continue
      }
      if (entry.isDirectory() && !entry.isSymbolicLink() && isRecordId(entry.name)) {
        const stat = fs.lstatSync(target)
        const canonical = fs.realpathSync(target)
        if (!stat.isDirectory() || stat.isSymbolicLink() || !contained(fs.realpathSync(dir), canonical)) {
          throw new Error(`Delegated worker archive ${entry.name} is not a contained real directory.`)
        }
        continue
      }
      throw new Error(`Unexpected entry in delegated worker metadata: ${entry.name}.`)
    }
    return { files: files.sort(), overflow: !exhausted }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], overflow: false }
    throw error
  } finally {
    handle?.closeSync()
  }
}

/**
 * Workers a run delegated to the other CLI.
 *
 * Neither harness can host the other's model, so a cross-harness run has the
 * orchestrator start the other CLI as a command. The app never owns that
 * process, so it would see none of its tokens — unless the child's own
 * structured stream is written where the app can read it. Every delegation
 * prompt therefore redirects the child into:
 *
 *   <workspace>/<run metadata dir>/agents/<slice>.<harness>.jsonl
 *
 * which is the same stream the app parses when it starts that CLI itself. One
 * parser per harness, serving both roles and delegated children alike.
 */
export function agentsDir(workspaceDir: string): string {
  return path.join(workspaceDir, RUN_METADATA_DIR, 'agents')
}

/** Resolve the agent-stream root without following workspace-planted directory symlinks. */
export function safeAgentsDir(workspaceDir: string, create = false): string {
  return safeWorkspaceMetadataDir(workspaceDir, ['agents'], create)
}

function childStreamBoundary(
  workspaceDir: string,
  expectedWorkspace: WorkspaceRootIdentity | undefined,
  requireEmpty: boolean,
  create: boolean,
): ChildStreamBoundary {
  const captured = expectedWorkspace
    ? {
        workspaceDir: assertLoopWorkspaceIdentity(expectedWorkspace, []),
        workspaceIdentity: expectedWorkspace.workspaceIdentity!,
      }
    : captureWorkspaceIdentity(workspaceDir, [])
  const canonicalWorkspace = captured.workspaceDir
  if (expectedWorkspace && canonicalWorkspace !== path.resolve(workspaceDir)) {
    throw new Error('Delegated worker workspace does not match its expected root identity.')
  }
  const dir = safeAgentsDir(canonicalWorkspace, create)
  assertLoopWorkspaceIdentity(captured, [])
  const inventory = childStreamInventory(dir)
  if (inventory.overflow) {
    throw new Error('Delegated worker preflight exceeded its bounded inventory.')
  }
  if (requireEmpty && inventory.files.length > 0) {
    throw new Error('Delegated worker preflight found live or excessive streams; archive them before starting the next phase.')
  }
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir || !contained(canonicalWorkspace, dir)) {
    throw new Error('Delegated worker directory is not a contained real directory.')
  }
  return {
    workspaceDir: canonicalWorkspace,
    workspaceDev: captured.workspaceIdentity.dev,
    workspaceIno: captured.workspaceIdentity.ino,
    dir,
    dev: stat.dev,
    ino: stat.ino,
  }
}

/** Claim the exact empty agents directory before a phase can delegate work. */
export function observeChildStreams(workspaceDir: string, expectedWorkspace?: WorkspaceRootIdentity): ChildStreamBoundary {
  return childStreamBoundary(workspaceDir, expectedWorkspace, true, true)
}

/** Reclaim the exact existing agents directory while attaching a durable run. */
export function recoverChildStreams(workspaceDir: string, expectedWorkspace?: WorkspaceRootIdentity): ChildStreamBoundary {
  return childStreamBoundary(workspaceDir, expectedWorkspace, false, false)
}

export function assertChildStreamBoundary(boundary: ChildStreamBoundary): string {
  assertLoopWorkspaceIdentity({
    workspaceDir: boundary.workspaceDir,
    workspaceIdentity: { dev: boundary.workspaceDev, ino: boundary.workspaceIno },
  }, [])
  const dir = safeAgentsDir(boundary.workspaceDir)
  assertLoopWorkspaceIdentity({
    workspaceDir: boundary.workspaceDir,
    workspaceIdentity: { dev: boundary.workspaceDev, ino: boundary.workspaceIno },
  }, [])
  const stat = fs.lstatSync(dir)
  if (
    dir !== boundary.dir
    || !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.dev !== boundary.dev
    || stat.ino !== boundary.ino
  ) throw new Error('Delegated worker directory disappeared or changed identity after preflight.')
  return dir
}

interface ChildTotals {
  tokens: TokenTotals
  model: string | null
  messages: number
  /** Codex names its thread on the first line; used to read live usage. */
  threadId?: string | null
  /** The CLI's own end-of-run event: claude's `result`, codex's completed turn. */
  ended: boolean
}

/** Claude writes one assistant event per message, repeating ids while streaming. */
function readClaudeStream(text: string): ChildTotals {
  const usageByMessage = new Map<string, Record<string, number>>()
  let model: string | null = null
  let ended = false
  for (const line of text.split('\n')) {
    if (!line.includes('"type"') && !line.includes('"usage"')) continue
    let obj: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      obj = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.type === 'result') ended = true
    if (!line.includes('"usage"')) continue
    const message = obj.message as Record<string, unknown> | undefined
    const usage = normalizeStreamUsage(message?.usage)
    if (!usage) continue
    if (typeof message?.model === 'string') model = message.model
    usageByMessage.set(String(message?.id ?? usageByMessage.size), usage)
  }
  const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const usage of usageByMessage.values()) {
    tokens.input += usage.input_tokens ?? 0
    tokens.output += usage.output_tokens ?? 0
    tokens.cacheRead += usage.cache_read_input_tokens ?? 0
    tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0
  }
  return { tokens, model, messages: usageByMessage.size, ended }
}

/** Codex reports usage once per completed turn. */
function readCodexStream(text: string): ChildTotals {
  const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let turns = 0
  let threadId: string | null = null
  let ended = false
  for (const line of text.split('\n')) {
    if (!line.includes('thread.started') && !line.includes('turn.completed')) continue
    let obj: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      obj = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.type === 'thread.started' && typeof obj.thread_id === 'string') threadId = obj.thread_id
    if (obj.type !== 'turn.completed') continue
    ended = true
    const usage = normalizeStreamUsage(obj.usage)
    if (usage) {
      const turn = codexTokens(usage)
      tokens.input += turn.input
      tokens.output += turn.output
      tokens.cacheRead += turn.cacheRead
      tokens.cacheWrite += turn.cacheWrite
      turns += 1
    }
  }
  return { tokens, model: null, messages: turns, ended, threadId }
}

/**
 * How long a stream must sit still before a worker counts as finished.
 *
 * A worker that printed its end-of-run event is almost certainly done, but a
 * codex child that spawned its own agents can emit one and keep working, so
 * even then the file has to go quiet. Without this every delegated row stayed
 * lit after its work was over.
 */
const ENDED_QUIET_MS = 15_000

interface OpenedChildStream {
  name: ReturnType<typeof parseChildStreamName> & {}
  file: string
  text: string
  stat: fs.Stats
}

function openedChildStreams(boundary: ChildStreamBoundary): OpenedChildStream[] {
  const dir = assertChildStreamBoundary(boundary)
  const inventory = childStreamInventory(dir)
  if (inventory.overflow) throw new Error(`Delegated worker inventory exceeded its ${MAX_CHILD_STREAMS}-stream/${MAX_CHILD_DIRECTORY_ENTRIES}-entry safety limit; refusing incomplete accounting.`)
  const streams: OpenedChildStream[] = []
  let totalBytes = 0
  for (const file of inventory.files) {
    const name = parseChildStreamName(file)
    if (!name) throw new Error(`Delegated worker stream name changed after inventory: ${file}.`)
    const filePath = path.join(dir, file)
    let descriptor: number | null = null
    try {
      const expected = fs.lstatSync(filePath)
      if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 || expected.size > MAX_CHILD_ACCOUNTING_FILE_BYTES) {
        throw new Error(`Delegated worker stream ${file} failed its accounting identity or size check.`)
      }
      if (totalBytes + expected.size > MAX_CHILD_ACCOUNTING_TOTAL_BYTES) {
        throw new Error(`Delegated worker streams exceed the ${MAX_CHILD_ACCOUNTING_TOTAL_BYTES / 1024 / 1024} MiB aggregate accounting limit.`)
      }
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      const stat = fs.fstatSync(descriptor)
      if (
        !stat.isFile()
        || stat.nlink !== 1
        || stat.size !== expected.size
        || stat.dev !== expected.dev
        || stat.ino !== expected.ino
      ) throw new Error(`Delegated worker stream ${file} changed identity while opening it.`)
      // Read only the size captured above. readFile(fd) follows concurrent
      // growth to EOF and could allocate far beyond the validated cap while a
      // delegated writer is still appending.
      const bytes = readExactFileDescriptor(
        descriptor,
        stat.size,
        MAX_CHILD_ACCOUNTING_FILE_BYTES,
        `Delegated worker stream ${file}`,
      )
      const after = fs.fstatSync(descriptor)
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.size < stat.size || after.size > MAX_CHILD_ACCOUNTING_FILE_BYTES || after.nlink !== 1) {
        throw new Error(`Delegated worker stream ${file} changed while accounting read it.`)
      }
      totalBytes += stat.size
      streams.push({ name, file, text: bytes.toString('utf8'), stat })
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor)
    }
  }
  return streams
}

/** One metric row per delegated worker, priced from its own stream. */
export function readChildAgents(boundary: ChildStreamBoundary, fallbackModel: string | null, codexHome?: string, now = Date.now()): AgentMetric[] {
  const rows: AgentMetric[] = []
  for (const { name: named, text, stat } of openedChildStreams(boundary)) {
    const totals = named.harness === 'claude' ? readClaudeStream(text) : readCodexStream(text)
    // Until a codex worker completes its turn its stream reports nothing, so
    // fall back to the running count in its own session log.
    const live = !totals.ended && codexHome && totals.threadId ? usageForThread(codexHome, totals.threadId) : null
    const tokens = live ?? totals.tokens
    const model = totals.model ?? fallbackModel
    const quietFor = now - stat.mtimeMs
    rows.push({
      id: childAgentMetricId(named.slug),
      label: `${named.harness}: ${named.slug}`,
      model,
      messages: totals.messages,
      tokens,
      firstTs: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
      lastTs: new Date(stat.mtimeMs).toISOString(),
      done: totals.ended && quietFor >= ENDED_QUIET_MS,
      totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
      costUsd: estimateCostUsd(model, tokens),
    })
  }
  return rows
}

/**
 * True while a delegated worker is still writing.
 *
 * The orchestrator can finish its turn while its children work on — a claude
 * agent in particular will not sit and wait, and did exactly that on a real
 * round, which committed a half-written build. So the app, not the agent,
 * decides when the round is over: any child stream touched inside the quiet
 * window counts as still running.
 */
export function childrenActive(boundary: ChildStreamBoundary, quietMs: number, now = Date.now()): boolean {
  return openedChildStreams(boundary).some(({ name, text, stat }) => {
    const ended = name.harness === 'claude' ? readClaudeStream(text).ended : readCodexStream(text).ended
    return !ended || now - stat.mtimeMs < quietMs
  })
}
