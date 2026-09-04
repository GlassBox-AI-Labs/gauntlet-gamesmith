import fs from 'node:fs'
import path from 'node:path'
import { codexAgentMetricId } from '../shared/agent-id'
import type { AgentMetric, TokenTotals } from '../shared/loop'
import { estimateCostUsd } from './pricing'

/**
 * Spend from codex runs launched inside an implement run.
 *
 * Claude Code cannot run a non-Claude model as a subagent, so a Codex subagent
 * is a cheap Claude dispatcher that shells out to `codex exec`. Those tokens
 * never reach Claude's own usage report, so they are read from codex itself:
 * it appends a running `token_count` event to its session log at
 * `$CODEX_HOME/sessions/<y>/<m>/<d>/rollout-<local ISO>-<id>.jsonl`. The
 * implement spawn sets CODEX_HOME, so every nested run lands there whatever
 * command line the dispatcher improvised — the count cannot be bypassed by an
 * agent that ignores its instructions.
 *
 * One rollout file is one codex session is one dispatched slice.
 */

const TAIL_BYTES = 512 * 1024
const MAX_USAGE_SCAN_BYTES = 8 * 1024 * 1024
const MAX_SESSION_ENTRIES = 20_000
const MAX_SESSION_DEPTH = 8
const MAX_MATCHED_ROLLOUTS = 256

function safeToken(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * `input_tokens` INCLUDES the cached and cache-written share — verified on a
 * real session, where `total_tokens` equals `input_tokens + output_tokens`
 * exactly with 11k of the 21k input cached. Billing the cached part again as
 * cacheRead would overstate the cost several times over, so it is subtracted
 * out here. Shared with the codex critic parser, which had the same trap.
 */
export function codexTokens(usage: Record<string, unknown> | undefined): TokenTotals {
  const cacheRead = safeToken(usage?.cached_input_tokens)
  const cacheWrite = safeToken(usage?.cache_write_input_tokens)
  return {
    input: Math.max(0, safeToken(usage?.input_tokens) - cacheRead - cacheWrite),
    output: safeToken(usage?.output_tokens),
    cacheRead,
    cacheWrite,
  }
}

function readBoundedTail(file: string, maximum: number): { text: string; from: number } | null {
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.nlink !== 1) return null
    const length = Math.min(stat.size, maximum)
    const from = stat.size - length
    const buffer = Buffer.allocUnsafe(length)
    const read = fs.readSync(descriptor, buffer, 0, length, from)
    return { text: buffer.subarray(0, read).toString('utf8'), from }
  } catch {
    return null
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function safeSessionsRoot(codexHome: string): string | null {
  try {
    const home = fs.realpathSync(codexHome)
    const candidate = path.join(home, 'sessions')
    const stat = fs.lstatSync(candidate)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    const root = fs.realpathSync(candidate)
    const relative = path.relative(home, root)
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? root : null
  } catch {
    return null
  }
}

/**
 * The newest cumulative usage in a rollout. `total_token_usage` is cumulative
 * for the whole session, so a re-read replaces the previous figure rather than
 * adding to it — polling this every few seconds cannot double count.
 */
function lastTotalUsage(file: string): Record<string, unknown> | null {
  const tail = readBoundedTail(file, MAX_USAGE_SCAN_BYTES)
  if (!tail) return null
  const lines = tail.text.split('\n')
  // A bounded tail can begin mid-line; never parse that fragment as trusted JSON.
  if (tail.from > 0) lines.shift()
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('token_count')) continue
    try {
      const parsed: unknown = JSON.parse(lines[i])
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const payload = (parsed as Record<string, unknown>).payload
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
      const info = (payload as Record<string, unknown>).info
      if (!info || typeof info !== 'object' || Array.isArray(info)) continue
      const usage = (info as Record<string, unknown>).total_token_usage
      if (usage && typeof usage === 'object' && !Array.isArray(usage)) return usage as Record<string, unknown>
    } catch {
      /* not the line we want */
    }
  }
  return null
}

interface RolloutState {
  id: string
  done: boolean
}

/** Stable session identity and terminal status from Codex's own rollout. */
function rolloutState(file: string): RolloutState {
  const name = path.basename(file)
  const id = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(name)?.[1]
    ?? name.slice('rollout-'.length, -'.jsonl'.length)
  const tail = readBoundedTail(file, TAIL_BYTES)
  if (!tail) return { id, done: false }
  const lines = tail.text.split('\n')
  if (tail.from > 0) lines.shift()
  let done = false
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      const payload = obj.payload as Record<string, unknown> | undefined
      const type = String(payload?.type ?? obj.type ?? '')
      if (type === 'task_complete' || type === 'turn.completed' || type === 'turn.failed' || type === 'turn_aborted') done = true
    } catch {
      /* A partial last line says nothing about terminal state. */
    }
  }
  return { id, done }
}

/** Every rollout file created at or after `sinceMs`, newest last. */
function rolloutsSince(codexHome: string, sinceMs: number): { file: string; startedAtMs: number; modifiedAtMs: number }[] {
  const root = safeSessionsRoot(codexHome)
  if (!root) return []
  // The file name carries the local-time date, so anything from an earlier day
  // is skipped without a stat; birthtime settles the rest.
  const sinceDay = new Date(sinceMs - 86_400_000).toISOString().slice(0, 10)
  const found: { file: string; startedAtMs: number; modifiedAtMs: number }[] = []
  let visited = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SESSION_DEPTH) throw new Error('Codex session search exceeded its directory depth limit.')
    let directory: fs.Dir
    try {
      directory = fs.opendirSync(dir)
    } catch {
      return
    }
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        visited += 1
        if (visited > MAX_SESSION_ENTRIES) throw new Error('Codex session search exceeded its entry limit.')
        const full = path.join(dir, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          walk(full, depth + 1)
        } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl') && entry.name.slice(8, 18) >= sinceDay) {
          const stat = fs.lstatSync(full)
          if (!stat.isFile() || stat.isSymbolicLink()) continue
          const startedAtMs = stat.birthtimeMs || stat.mtimeMs
          if (startedAtMs >= sinceMs) {
            found.push({ file: full, startedAtMs, modifiedAtMs: stat.mtimeMs })
            if (found.length > MAX_MATCHED_ROLLOUTS) throw new Error(`Codex usage exceeds ${MAX_MATCHED_ROLLOUTS} matching sessions.`)
          }
        }
      }
    } finally {
      directory.closeSync()
    }
  }
  walk(root, 0)
  return found.sort((a, b) => a.startedAtMs - b.startedAtMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

/**
 * Live cumulative usage for one codex thread, by id.
 *
 * A delegated worker's `--json` stream reports usage only when its turn ends,
 * so a worker that has been building for twenty minutes reads as zero tokens —
 * indistinguishable from one that died on launch. Its session log carries a
 * running count the whole time, and the stream's first line names the thread,
 * so the two can be joined while the work is still going.
 */
export function usageForThread(codexHome: string, threadId: string): TokenTotals | null {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(threadId)) return null
  const root = safeSessionsRoot(codexHome)
  if (!root) return null
  let visited = 0
  const matches: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SESSION_DEPTH) throw new Error('Codex thread search exceeded its directory depth limit.')
    let directory: fs.Dir
    try {
      directory = fs.opendirSync(dir)
    } catch {
      return
    }
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        visited += 1
        if (visited > MAX_SESSION_ENTRIES) throw new Error('Codex thread search exceeded its entry limit.')
        const full = path.join(dir, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full, depth + 1)
        else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) matches.push(full)
      }
    } finally {
      directory.closeSync()
    }
  }
  walk(root, 0)
  if (matches.length !== 1) return null
  const usage = lastTotalUsage(matches[0])
  return usage ? codexTokens(usage) : null
}

/**
 * One metric row per codex session started since `sinceMs`, priced from its own
 * token count. `exceptThreadId` drops the orchestrator's own session, whose
 * tokens the run already counts from its live stream.
 */
export function readCodexUsage(codexHome: string, sinceMs: number, model: string, exceptThreadId?: string | null): AgentMetric[] {
  return rolloutsSince(codexHome, sinceMs).flatMap(({ file, startedAtMs, modifiedAtMs }, index) => {
    if (exceptThreadId && path.basename(file).includes(exceptThreadId)) return []
    const usage = lastTotalUsage(file)
    if (!usage) return []
    const state = rolloutState(file)
    const tokens = codexTokens(usage)
    return [
      {
        id: codexAgentMetricId(state.id),
        label: `codex slice ${index + 1}`,
        model,
        messages: 1,
        tokens,
        firstTs: new Date(startedAtMs).toISOString(),
        lastTs: new Date(modifiedAtMs).toISOString(),
        done: state.done,
        state: state.done ? 'done' : 'progress',
        totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
        costUsd: estimateCostUsd(model, tokens),
      },
    ]
  })
}
