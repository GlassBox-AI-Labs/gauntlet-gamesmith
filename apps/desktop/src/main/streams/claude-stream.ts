import type { LogChannel } from '../../shared/loop'
import { canonicalModelId } from '../../shared/models'
import { normalizeSessionId } from '../../shared/session-id'

/**
 * Pure translation of one raw CLI stream line into schema events. The role
 * parsers in loop-runner.ts are thin decorators over these: they add the
 * run-specific prefix, accounting, and control flow, so the translators stay
 * run-agnostic and every agent's stream reads the same way in the log.
 */
export interface StreamEvent {
  channel: LogChannel
  /** Legacy log kind, kept populated for old readers and the UI color map. */
  kind: string
  text: string
  /** Claude identifies nested agents by the tool-use id that launched them. */
  agentId?: string
}

export function trunc(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Keep the END of the text instead of the start.
 *
 * A failing command says why on its last lines: the compiler's error list, a
 * test harness's verdict, a stack trace. Truncating from the front kept the
 * banner and threw the reason away, so the log filled with red lines reading
 * `command failed: src/sim/types.ts src/sim/content.ts …` — a file listing
 * that `rg` printed before a later command in the same shell exited non-zero.
 * Use this wherever the payload is a command's own output.
 */
export function truncTail(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `…${flat.slice(-max)}` : flat
}

export interface ClaudeLineResult {
  events: StreamEvent[]
  /** Present when this line was the CLI's system/init event. */
  init?: { sessionId: string | null; model: string | null }
  /** Per-message usage from an assistant event; the same id repeats while streaming. */
  usage?: { messageId: string | null; model: string | null; usage: Record<string, number> }
  /** Last assistant text block on this line — the summary candidate. */
  summary?: string
  /** The CLI's final result event. */
  result?: {
    text: string | null
    usage?: Record<string, number>
    isError: boolean
    subtype: string | null
    raw: Record<string, unknown>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function excerpt(value: unknown): string {
  try {
    return trunc(JSON.stringify(value), 160)
  } catch {
    return trunc(String(value), 160)
  }
}

function streamAgentId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : undefined
}

/** Token arithmetic accepts only finite, nonnegative values from the CLI. */
export function normalizeStreamUsage(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const usage: Record<string, number> = {}
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    // Claude's aggregate `modelUsage` uses camelCase for the same counters.
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
  ]) {
    const raw = value[key]
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) usage[key] = raw
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

/**
 * Usage-window heartbeat, emitted every few turns. Current CLIs send
 * `rate_limit_info` carrying per-window utilization and epoch-second resets;
 * older ones sent only a top-level `reset_at` ISO string, and that shape is
 * still read. Purely informational — the pause/retry path keys off turn
 * failures, not this event — but the percentages are how an operator sees a
 * long run drifting toward a stall, so every window the CLI reports is shown
 * and the reset shown is the one for the window nearest its limit.
 */
function rateLimitText(obj: Record<string, unknown>): string | null {
  const info = isRecord(obj.rate_limit_info) ? obj.rate_limit_info : null
  if (info) {
    const windows = isRecord(info.unifiedWindows) ? info.unifiedWindows : {}
    const used = Object.entries(windows).flatMap(([name, window]) =>
      isRecord(window) && typeof window.utilization === 'number'
        ? [{ name, utilization: window.utilization, resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt : null }]
        : [],
    )
    if (used.length === 0) return null
    const nearest = used.reduce((worst, entry) => (entry.utilization > worst.utilization ? entry : worst))
    const reset = nearest.resetsAt === null ? '' : `; ${nearest.name} resets ${new Date(nearest.resetsAt * 1_000).toISOString()}`
    const status = typeof info.status === 'string' && info.status !== 'allowed' ? ` [${info.status}]` : ''
    return `Claude usage${status}: ${used.map((entry) => `${entry.name} ${Math.round(entry.utilization * 100)}%`).join(' · ')}${reset}`
  }
  if (typeof obj.reset_at === 'string') {
    const resetAtMs = Date.parse(obj.reset_at)
    if (Number.isFinite(resetAtMs)) return `Claude rate limit; reset at: ${new Date(resetAtMs).toISOString()}`
  }
  return null
}

function systemEvent(label: string, value: unknown, agentId?: string): StreamEvent {
  return {
    channel: 'system',
    kind: 'system',
    text: `unhandled claude ${label}: ${excerpt(value)}`,
    ...(agentId ? { agentId } : {}),
  }
}

export function translateClaudeLine(line: string): ClaudeLineResult | null {
  if (!line.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { events: [systemEvent('non-JSON line', line)] }
  }
  if (!isRecord(parsed)) return { events: [systemEvent('malformed event', parsed)] }
  const obj = parsed
  const out: ClaudeLineResult = { events: [] }
  const type = typeof obj.type === 'string' ? obj.type : 'unknown'
  const agentId = streamAgentId(obj.parent_tool_use_id)
  const push = (event: StreamEvent): void => {
    out.events.push(agentId ? { agentId, ...event } : event)
  }
  if (type === 'system' && obj.subtype === 'init') {
    out.init = {
      sessionId: normalizeSessionId(obj.session_id),
      model: canonicalModelId(typeof obj.model === 'string' ? obj.model : null),
    }
    return out
  }
  if (type === 'rate_limit_event') {
    const text = rateLimitText(obj)
    if (text) {
      push({ channel: 'system', kind: 'system', text })
      return out
    }
  }
  /**
   * Background-task and heartbeat events. The CLI reports subagent progress,
   * long-tool liveness, and thinking-token estimates out of band from the
   * assistant stream. Each task event names the `tool_use_id` that owns it —
   * the same id the spawn line used — so the log files them under the agent
   * that produced them instead of the parent's stream.
   */
  if (type === 'tool_progress') {
    const tool = typeof obj.tool_name === 'string' ? obj.tool_name : 'tool'
    const elapsed = typeof obj.elapsed_time_seconds === 'number' ? ` (${Math.round(obj.elapsed_time_seconds)}s)` : ''
    push({ channel: 'tool', kind: 'tool', text: `⋯ ${tool} still running${elapsed}` })
    return out
  }
  if (type === 'system' && typeof obj.subtype === 'string') {
    const owner = streamAgentId(obj.tool_use_id) ? { agentId: streamAgentId(obj.tool_use_id) } : {}
    const description = typeof obj.description === 'string' ? trunc(obj.description, 80) : ''
    if (obj.subtype === 'thinking_tokens' && typeof obj.estimated_tokens === 'number') {
      // A running estimate, not a per-message total: it belongs with the other
      // token counters, not in the thought stream it is counting.
      push({ channel: 'usage', kind: 'metric', text: `𝜓 thinking ≈${obj.estimated_tokens} tokens` })
      return out
    }
    if (obj.subtype === 'task_started') {
      const taskType = typeof obj.task_type === 'string' ? obj.task_type : 'task'
      // The task type is reported verbatim: only the role parser knows which
      // tracked tasks are subagents, so the translator does not claim a spawn.
      push({ ...owner, channel: 'tool', kind: 'tool', text: `▶ ${taskType} started "${description}"` })
      return out
    }
    if (obj.subtype === 'task_progress') {
      const usage = isRecord(obj.usage) ? obj.usage : {}
      const detail = [
        typeof usage.total_tokens === 'number' ? `${usage.total_tokens} tokens` : null,
        typeof usage.tool_uses === 'number' ? `${usage.tool_uses} tools` : null,
        typeof usage.duration_ms === 'number' ? `${Math.round(usage.duration_ms / 1_000)}s` : null,
        typeof obj.last_tool_name === 'string' ? obj.last_tool_name : null,
      ].filter((part): part is string => part !== null)
      push({ ...owner, channel: 'tool', kind: 'tool', text: `⋯ ${description}${detail.length > 0 ? ` (${detail.join(' · ')})` : ''}` })
      return out
    }
    if (obj.subtype === 'task_notification') {
      const status = typeof obj.status === 'string' ? obj.status : 'finished'
      const summary = typeof obj.summary === 'string' && obj.summary.trim() ? `: ${trunc(obj.summary, 200)}` : ''
      push(status === 'completed'
        ? { ...owner, channel: 'tool', kind: 'tool', text: `✓ task completed${summary}` }
        : { ...owner, channel: 'error', kind: 'error', text: `✗ task ${status}${summary}` })
      return out
    }
    if (obj.subtype === 'background_tasks_changed' && Array.isArray(obj.tasks)) {
      const running = obj.tasks.flatMap((task) =>
        isRecord(task) && typeof task.description === 'string' ? [trunc(task.description, 60)] : [])
      push({ channel: 'system', kind: 'system', text: `background tasks: ${running.length > 0 ? running.join(' · ') : 'none'}` })
      return out
    }
  }
  if (type === 'assistant') {
    const message = isRecord(obj.message) ? obj.message : null
    if (!message) {
      push(systemEvent('assistant event without a message', obj))
      return out
    }
    const messageUsage = normalizeStreamUsage(message.usage)
    if (messageUsage) {
      out.usage = {
        messageId: typeof message.id === 'string' ? message.id : null,
        model: canonicalModelId(typeof message.model === 'string' ? message.model : null),
        usage: messageUsage,
      }
    }
    const content = Array.isArray(message.content) ? message.content : []
    if (!Array.isArray(message.content)) push(systemEvent('assistant message without content', message))
    for (const rawBlock of content) {
      if (!isRecord(rawBlock)) {
        push(systemEvent('malformed content block', rawBlock))
        continue
      }
      const block = rawBlock
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.summary = block.text
        push({ channel: 'output', kind: 'claude', text: trunc(block.text, 400) })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        // Interleaved thinking arrives as signature-only blocks with no text.
        // They still mark a thinking turn, so they get a line of their own.
        push(block.thinking.trim()
          ? { channel: 'thought', kind: 'thought', text: `𝜓 ${trunc(block.thinking, 500)}` }
          : { channel: 'thought', kind: 'thought', text: '𝜓 (thinking withheld)' })
      } else if (block.type === 'redacted_thinking') {
        push({ channel: 'system', kind: 'system', text: 'claude emitted a redacted thinking block' })
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        const name = typeof block.name === 'string' ? block.name : String(block.type)
        const input = isRecord(block.input) ? block.input : undefined
        if (name === 'Agent' || name === 'Task') {
          const labelSource = typeof input?.description === 'string'
            ? input.description
            : typeof input?.subagent_type === 'string'
              ? input.subagent_type
              : 'subagent'
          const label = trunc(labelSource, 30)
          const model = typeof input?.model === 'string' ? input.model : null
          push({
            channel: 'tool',
            kind: 'spawn',
            text: `⇉ spawns "${label}"${model ? ` (${model})` : ''}`,
            ...(streamAgentId(block.id) ? { agentId: streamAgentId(block.id) } : {}),
          })
        } else if (name === 'WebSearch') {
          push({ channel: 'search', kind: 'search', text: `⌕ ${trunc(String(input?.query ?? ''), 200)}` })
        } else if (name === 'Bash') {
          push({ channel: 'tool', kind: 'cmd', text: `$ ${trunc(String(input?.command ?? ''), 200)}` })
        } else {
          push({ channel: 'tool', kind: 'tool', text: `→ ${name} ${input ? excerpt(input) : ''}` })
        }
      } else if (block.type === 'web_search_tool_result') {
        push({ channel: 'search', kind: 'search', text: `⌕ web search result ${excerpt(block.content ?? block)}` })
      } else {
        push(systemEvent(`content block "${String(block.type ?? 'unknown')}"`, block))
      }
    }
    return out
  }
  if (type === 'user') {
    const message = isRecord(obj.message) ? obj.message : null
    const content = Array.isArray(message?.content) ? message.content : []
    if (!message || !Array.isArray(message.content)) push(systemEvent('user event without tool results', obj))
    for (const rawBlock of content) {
      if (!isRecord(rawBlock)) {
        push(systemEvent('malformed user content block', rawBlock))
        continue
      }
      const block = rawBlock
      if (block.type === 'tool_result') {
        push(
          block.is_error
            ? { channel: 'error', kind: 'error', text: `✗ tool error: ${truncTail(JSON.stringify(block.content ?? ''), 300)}` }
            : { channel: 'tool', kind: 'tool', text: `← tool result: ${trunc(JSON.stringify(block.content ?? ''), 300)}` },
        )
      } else {
        push(systemEvent(`user content block "${String(block.type ?? 'unknown')}"`, block))
      }
    }
    return out
  }
  if (type === 'result') {
    out.result = {
      text: typeof obj.result === 'string' ? obj.result : null,
      usage: normalizeStreamUsage(obj.usage),
      isError: obj.is_error === true,
      subtype: typeof obj.subtype === 'string' ? obj.subtype : null,
      raw: obj,
    }
    if (out.result.isError) {
      push({
        channel: 'error',
        kind: 'error',
        text: `claude result ${out.result.subtype ?? 'failed'}${out.result.text ? `: ${trunc(out.result.text, 300)}` : ''}`,
      })
    }
    return out
  }
  push(systemEvent(`event "${type}${typeof obj.subtype === 'string' ? `/${obj.subtype}` : ''}"`, obj))
  return out
}
