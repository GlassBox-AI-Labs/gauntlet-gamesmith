import fs from 'node:fs'
import path from 'node:path'
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

/**
 * `input_tokens` INCLUDES the cached and cache-written share — verified on a
 * real session, where `total_tokens` equals `input_tokens + output_tokens`
 * exactly with 11k of the 21k input cached. Billing the cached part again as
 * cacheRead would overstate the cost several times over, so it is subtracted
 * out here. Shared with the codex critic parser, which had the same trap.
 */
export function codexTokens(usage: Record<string, number> | undefined): TokenTotals {
  const cacheRead = usage?.cached_input_tokens ?? 0
  const cacheWrite = usage?.cache_write_input_tokens ?? 0
  return {
    input: Math.max(0, (usage?.input_tokens ?? 0) - cacheRead - cacheWrite),
    output: usage?.output_tokens ?? 0,
    cacheRead,
    cacheWrite,
  }
}

/**
 * The newest cumulative usage in a rollout. `total_token_usage` is cumulative
 * for the whole session, so a re-read replaces the previous figure rather than
 * adding to it — polling this every few seconds cannot double count.
 */
function lastTotalUsage(file: string, size: number): Record<string, number> | null {
  const scan = (from: number): Record<string, number> | null => {
    let fd: number
    try {
      fd = fs.openSync(file, 'r')
    } catch {
      return null
    }
    try {
      const buf = Buffer.alloc(size - from)
      fs.readSync(fd, buf, 0, buf.length, from)
      const lines = buf.toString('utf8').split('\n')
      // A tail read starts mid-line; that first fragment is not parseable.
      if (from > 0) lines.shift()
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].includes('token_count')) continue
        try {
          const usage = JSON.parse(lines[i])?.payload?.info?.total_token_usage
          if (usage) return usage as Record<string, number>
        } catch {
          /* not the line we want */
        }
      }
      return null
    } finally {
      fs.closeSync(fd)
    }
  }
  const from = Math.max(0, size - TAIL_BYTES)
  // Token counts are appended constantly, so the tail almost always has one.
  // A miss means one huge line pushed them out of the window — rare enough to
  // pay for a full read rather than silently undercount the slice.
  return scan(from) ?? (from > 0 ? scan(0) : null)
}

/** Every rollout file created at or after `sinceMs`, newest last. */
function rolloutsSince(codexHome: string, sinceMs: number): { file: string; size: number; startedAtMs: number }[] {
  const root = path.join(codexHome, 'sessions')
  // The file name carries the local-time date, so anything from an earlier day
  // is skipped without a stat; birthtime settles the rest.
  const sinceDay = new Date(sinceMs - 86_400_000).toISOString().slice(0, 10)
  const found: { file: string; size: number; startedAtMs: number }[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl') && entry.name.slice(8, 18) >= sinceDay) {
        try {
          const stat = fs.statSync(full)
          const startedAtMs = stat.birthtimeMs || stat.mtimeMs
          if (startedAtMs >= sinceMs) found.push({ file: full, size: stat.size, startedAtMs })
        } catch {
          /* vanished mid-scan */
        }
      }
    }
  }
  walk(root)
  return found.sort((a, b) => a.startedAtMs - b.startedAtMs)
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
  const walk = (dir: string): string | null => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const hit = walk(full)
        if (hit) return hit
      } else if (entry.name.includes(threadId) && entry.name.endsWith('.jsonl')) {
        return full
      }
    }
    return null
  }
  const file = walk(path.join(codexHome, 'sessions'))
  if (!file) return null
  try {
    const usage = lastTotalUsage(file, fs.statSync(file).size)
    return usage ? codexTokens(usage) : null
  } catch {
    return null
  }
}

/**
 * One metric row per codex session started since `sinceMs`, priced from its own
 * token count. `exceptThreadId` drops the orchestrator's own session, whose
 * tokens the run already counts from its live stream.
 */
export function readCodexUsage(codexHome: string, sinceMs: number, model: string, exceptThreadId?: string | null): AgentMetric[] {
  return rolloutsSince(codexHome, sinceMs).flatMap(({ file, size, startedAtMs }, index) => {
    if (exceptThreadId && path.basename(file).includes(exceptThreadId)) return []
    const usage = lastTotalUsage(file, size)
    if (!usage) return []
    const tokens = codexTokens(usage)
    return [
      {
        id: `codex:${path.basename(file, '.jsonl').slice(-12)}`,
        label: `codex slice ${index + 1}`,
        model,
        messages: 1,
        tokens,
        firstTs: new Date(startedAtMs).toISOString(),
        lastTs: new Date().toISOString(),
        totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
        costUsd: estimateCostUsd(model, tokens),
      },
    ]
  })
}
