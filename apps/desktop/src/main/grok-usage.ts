import fs from 'node:fs'
import path from 'node:path'
import type { AgentMetric, TokenTotals } from '../shared/loop'
import { estimateCostUsd } from './pricing'

/**
 * Per-worker rows for a run driven by grok.
 *
 * Grok forwards a subagent's messages into the parent stream but leaves
 * `parent_tool_use_id` null on every one, so the stream alone cannot say who
 * did what. The identity is on disk instead: each spawn writes
 *
 *   $GROK_HOME/sessions/<url-encoded cwd>/<parent id>/subagents/<child id>/meta.json
 *
 * and the child gets a full session directory of its own alongside the parent,
 * whose `updates.jsonl` carries a `turn_completed` event with its exact usage.
 *
 * These rows **split** the run total rather than adding to it — the worker's
 * tokens are already inside the parent's figures, which is the opposite of how
 * codex and cross-harness workers behave.
 */

export interface GrokWorker extends AgentMetric {
  status: string
}

export interface GrokToolOwner {
  id: string
  label: string
}

/**
 * Maps a grok tool-call id to the worker that issued it.
 *
 * Grok copies each child's tool call into the parent stream with
 * `parent_tool_use_id` left null, so the live log would otherwise stamp every
 * write as the orchestrator. The child's own `updates.jsonl` records the same
 * `toolCallId` under that child's session, and that file is written before the
 * parent stream forwards the event.
 */
export class GrokToolOwnerIndex {
  private readonly owners = new Map<string, GrokToolOwner>()
  private readonly offsets = new Map<string, number>()
  private readonly partials = new Map<string, Buffer>()

  constructor(
    private readonly grokHome: string,
    private readonly workspaceDir: string,
  ) {}

  poll(parentSessionId: string | null): void {
    if (!parentSessionId) return
    const sessions = sessionsDirFor(this.grokHome, this.workspaceDir)
    if (!sessions) return
    const dir = path.join(sessions, parentSessionId, 'subagents')
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const id of entries) {
      let meta: WorkerMeta
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8')) as WorkerMeta
      } catch {
        continue
      }
      const child = meta.child_session_id ?? id
      const label = meta.description ?? meta.subagent_type ?? `subagent ${child.slice(-6)}`
      this.ingest(path.join(sessions, child, 'updates.jsonl'), child, { id: `worker:${child}`, label })
    }
  }

  ownerOf(toolCallId: string | null | undefined): GrokToolOwner | null {
    if (!toolCallId) return null
    return this.owners.get(toolCallId) ?? null
  }

  private ingest(file: string, child: string, owner: GrokToolOwner): void {
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      return
    }
    let offset = this.offsets.get(child) ?? 0
    if (stat.size < offset) offset = 0
    if (stat.size <= offset) return
    let buf: Buffer
    try {
      const fd = fs.openSync(file, 'r')
      try {
        buf = Buffer.allocUnsafe(stat.size - offset)
        const read = fs.readSync(fd, buf, 0, buf.length, offset)
        buf = buf.subarray(0, read)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return
    }
    this.offsets.set(child, offset + buf.length)
    const combined = Buffer.concat([this.partials.get(child) ?? Buffer.alloc(0), buf])
    const lastNewline = combined.lastIndexOf(0x0a)
    if (lastNewline < 0) {
      this.partials.set(child, combined)
      return
    }
    this.partials.set(child, combined.subarray(lastNewline + 1))
    for (const line of combined.subarray(0, lastNewline).toString('utf8').split('\n')) {
      if (!line.includes('toolCallId')) continue
      try {
        const obj = JSON.parse(line) as { params?: { update?: { toolCallId?: string } } }
        const toolCallId = obj.params?.update?.toolCallId
        if (typeof toolCallId === 'string') this.owners.set(toolCallId, owner)
      } catch {
        /* skip a torn or unrelated line */
      }
    }
  }
}

/** Grok keys a session directory by the URL-encoded absolute working directory. */
function sessionsDirFor(grokHome: string, workspaceDir: string): string | null {
  const root = path.join(grokHome, 'sessions')
  let resolved = workspaceDir
  try {
    resolved = fs.realpathSync(workspaceDir)
  } catch {
    /* the raw path is the best guess */
  }
  for (const candidate of new Set([resolved, workspaceDir])) {
    const dir = path.join(root, encodeURIComponent(candidate))
    if (fs.existsSync(dir)) return dir
  }
  return null
}

/**
 * The newest `turn_completed` usage for one session.
 *
 * **`inputTokens` here includes the cached share**, the opposite of the
 * convention in the run's `result` event. Subtracting it out is the same
 * correction `codexTokens` makes, and skipping it overstates cost several-fold.
 * `costUsdTicks` is USD scaled by 1e10 — checked against grok-4.6 list prices:
 * (17558 − 8704) × $2/M + 8704 × $0.50/M + 289 × $6/M = $0.023794 = 237940000 ÷ 1e10.
 */
function childUsage(file: string): { tokens: TokenTotals; costUsd: number | null; turns: number } | null {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('turn_completed')) continue
    let update: Record<string, unknown> | undefined
    try {
      update = (JSON.parse(lines[i]) as { params?: { update?: Record<string, unknown> } }).params?.update
    } catch {
      continue
    }
    const usage = update?.usage as Record<string, number> | undefined
    if (!usage) continue
    const cacheRead = usage.cachedReadTokens ?? 0
    const cacheWrite = usage.cacheCreationTokens ?? 0
    // numTurns / modelCalls live on the usage object in real grok traces, not
    // on the update wrapper. Reading the wrapper left every worker at 0 msgs.
    const turns =
      (typeof usage.numTurns === 'number' ? usage.numTurns : 0) ||
      (typeof usage.modelCalls === 'number' ? usage.modelCalls : 0) ||
      (typeof update?.numTurns === 'number' ? update.numTurns : 0)
    return {
      tokens: {
        input: Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite),
        output: usage.outputTokens ?? 0,
        cacheRead,
        cacheWrite,
      },
      costUsd: typeof usage.costUsdTicks === 'number' ? usage.costUsdTicks / 1e10 : null,
      turns,
    }
  }
  return null
}

/** How many model round-trips a still-running child has started. */
function countFirstTokens(eventsFile: string): number {
  let text: string
  try {
    text = fs.readFileSync(eventsFile, 'utf8')
  } catch {
    return 0
  }
  let n = 0
  for (const line of text.split('\n')) {
    if (line.includes('"type":"first_token"')) n += 1
  }
  return n
}

function childSummary(file: string): { num_chat_messages?: number; last_active_at?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { num_chat_messages?: number; last_active_at?: string }
  } catch {
    return null
  }
}

interface WorkerMeta {
  child_session_id?: string
  subagent_type?: string
  description?: string
  status?: string
  started_at?: string
  completed_at?: string
  duration_ms?: number
  tool_calls?: number
  effective_model_id?: string
}

/** One row per subagent this run spawned, priced from the child's own record. */
/**
 * Grok's session files stamp microseconds (`…:05.651236Z`); the ledger's agent
 * contract accepts only millisecond ISO, and rejects the whole metrics blob
 * otherwise. Anything unparseable becomes null rather than a bad timestamp.
 */
function isoMillis(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

export function readGrokWorkers(grokHome: string, workspaceDir: string, parentSessionId: string | null): GrokWorker[] {
  if (!parentSessionId) return []
  const sessions = sessionsDirFor(grokHome, workspaceDir)
  if (!sessions) return []
  const dir = path.join(sessions, parentSessionId, 'subagents')
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const rows: GrokWorker[] = []
  for (const id of entries.sort()) {
    let meta: WorkerMeta
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8')) as WorkerMeta
    } catch {
      continue
    }
    const child = meta.child_session_id ?? id
    const usage = childUsage(path.join(sessions, child, 'updates.jsonl'))
    const summary = childSummary(path.join(sessions, child, 'summary.json'))
    const tokens = usage?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    // A running child has no turn_completed yet, so billed tokens stay 0 —
    // but first_token events (and the summary) still prove it is working.
    const messages = usage?.turns || countFirstTokens(path.join(sessions, child, 'events.jsonl')) || summary?.num_chat_messages || 0
    const model = meta.effective_model_id ?? null
    rows.push({
      id: `worker:${child}`,
      label: meta.description ?? meta.subagent_type ?? `subagent ${child.slice(-6)}`,
      model,
      messages,
      tokens,
      firstTs: isoMillis(meta.started_at),
      lastTs: isoMillis(meta.completed_at ?? summary?.last_active_at ?? meta.started_at),
      done: meta.status === 'completed' || meta.status === 'failed',
      status: meta.status ?? 'unknown',
      toolCalls: meta.tool_calls,
      durationMs: meta.duration_ms,
      totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
      costUsd: estimateCostUsd(model, tokens) ?? usage?.costUsd ?? null,
    })
  }
  return rows
}

/** What the workers spent in total — the share to take off the orchestrator's row. */
export function grokWorkerTotals(workers: GrokWorker[]): TokenTotals {
  const total: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const w of workers) {
    total.input += w.tokens.input
    total.output += w.tokens.output
    total.cacheRead += w.tokens.cacheRead
    total.cacheWrite += w.tokens.cacheWrite
  }
  return total
}
