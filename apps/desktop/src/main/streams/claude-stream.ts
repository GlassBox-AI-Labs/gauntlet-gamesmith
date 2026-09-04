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

export interface ClaudeLineResult {
  events: StreamEvent[]
  /** Present when this line was the CLI's system/init event. */
  init?: { sessionId: string | null; model: string | null }
  /** Per-message usage from an assistant event; the same id repeats while streaming. */
  usage?: { messageId: string | null; model: string | null; usage: Record<string, number> }
  /** Last assistant text block on this line — the summary candidate. */
  summary?: string
  /** The CLI's final result event. */
  result?: { text: string | null; usage?: Record<string, number>; isError: boolean; subtype: string | null; raw: Record<string, unknown> }
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
  if (type === 'rate_limit_event' && typeof obj.reset_at === 'string') {
    const resetAtMs = Date.parse(obj.reset_at)
    if (Number.isFinite(resetAtMs)) {
      push({ channel: 'system', kind: 'system', text: `Claude rate limit; reset at: ${new Date(resetAtMs).toISOString()}` })
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
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        push({ channel: 'thought', kind: 'thought', text: `𝜓 ${trunc(block.thinking, 500)}` })
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
            ? { channel: 'error', kind: 'error', text: `✗ tool error: ${trunc(JSON.stringify(block.content ?? ''), 300)}` }
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
