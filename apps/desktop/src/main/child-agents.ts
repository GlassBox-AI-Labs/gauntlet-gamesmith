import fs from 'node:fs'
import path from 'node:path'
import type { AgentMetric, TokenTotals } from '../shared/loop'
import { codexTokens, usageForThread } from './codex-usage'
import { estimateCostUsd } from './pricing'
import { RUN_METADATA_DIR } from './run-transfer'

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
    if (line.includes('"type":"result"')) ended = true
    if (!line.includes('"usage"')) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const message = obj.message as Record<string, unknown> | undefined
    const usage = message?.usage as Record<string, number> | undefined
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
  for (const line of text.split('\n')) {
    if (line.includes('thread.started')) {
      try {
        threadId = (JSON.parse(line) as { thread_id?: string }).thread_id ?? null
      } catch {
        /* partial first line */
      }
    }
    if (!line.includes('turn.completed')) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const turn = codexTokens(obj.usage as Record<string, number> | undefined)
    tokens.input += turn.input
    tokens.output += turn.output
    tokens.cacheRead += turn.cacheRead
    tokens.cacheWrite += turn.cacheWrite
    turns += 1
  }
  return { tokens, model: null, messages: turns, ended: turns > 0, threadId }
}

/** `<slice>.<harness>.jsonl` — the harness is in the name so nothing has to sniff. */
function parseName(file: string): { slice: string; harness: 'claude' | 'codex' } | null {
  const match = /^(.+)\.(claude|codex)\.jsonl$/.exec(file)
  return match ? { slice: match[1], harness: match[2] as 'claude' | 'codex' } : null
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
const SILENT_QUIET_MS = 2 * 60_000

/** One metric row per delegated worker, priced from its own stream. */
export function readChildAgents(workspaceDir: string, fallbackModel: string | null, codexHome?: string, now = Date.now()): AgentMetric[] {
  const dir = agentsDir(workspaceDir)
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  const rows: AgentMetric[] = []
  for (const file of files.sort()) {
    const named = parseName(file)
    if (!named) continue
    let text: string
    let stat: fs.Stats
    try {
      stat = fs.statSync(path.join(dir, file))
      text = fs.readFileSync(path.join(dir, file), 'utf8')
    } catch {
      continue
    }
    const totals = named.harness === 'claude' ? readClaudeStream(text) : readCodexStream(text)
    // Until a codex worker completes its turn its stream reports nothing, so
    // fall back to the running count in its own session log.
    const live = !totals.ended && codexHome && totals.threadId ? usageForThread(codexHome, totals.threadId) : null
    const tokens = live ?? totals.tokens
    const model = totals.model ?? fallbackModel
    const quietFor = now - stat.mtimeMs
    rows.push({
      id: `child:${named.slice}`,
      label: `${named.harness}: ${named.slice}`,
      model,
      messages: totals.messages,
      tokens,
      firstTs: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
      lastTs: new Date(stat.mtimeMs).toISOString(),
      done: quietFor >= (totals.ended ? ENDED_QUIET_MS : SILENT_QUIET_MS),
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
export function childrenActive(workspaceDir: string, quietMs: number, now = Date.now()): boolean {
  const dir = agentsDir(workspaceDir)
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return false
  }
  return files.some((file) => {
    if (!parseName(file)) return false
    try {
      return now - fs.statSync(path.join(dir, file)).mtimeMs < quietMs
    } catch {
      return false
    }
  })
}
