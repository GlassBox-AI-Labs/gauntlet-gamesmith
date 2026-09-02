import type { LogChannel } from '../../shared/loop'

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

export function translateClaudeLine(line: string): ClaudeLineResult | null {
  if (!line.trim()) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const out: ClaudeLineResult = { events: [] }
  const type = obj.type as string
  if (type === 'system' && obj.subtype === 'init') {
    out.init = { sessionId: (obj.session_id as string | undefined) ?? null, model: (obj.model as string | undefined) ?? null }
    return out
  }
  if (type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined
    if (!message) return out
    if (message.usage && typeof message.usage === 'object') {
      out.usage = {
        messageId: (message.id as string | undefined) ?? null,
        model: (message.model as string | undefined) ?? null,
        usage: message.usage as Record<string, number>,
      }
    }
    const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.summary = block.text
        out.events.push({ channel: 'output', kind: 'claude', text: trunc(block.text, 400) })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        out.events.push({ channel: 'thought', kind: 'thought', text: `𝜓 ${trunc(block.thinking, 500)}` })
      } else if (block.type === 'tool_use') {
        const name = String(block.name)
        const input = block.input as Record<string, unknown> | undefined
        if (name === 'Agent' || name === 'Task') {
          const label = trunc((input?.description as string | undefined) ?? (input?.subagent_type as string | undefined) ?? 'subagent', 30)
          const model = (input?.model as string | undefined) ?? null
          out.events.push({ channel: 'tool', kind: 'spawn', text: `⇉ spawns "${label}"${model ? ` (${model})` : ''}` })
        } else if (name === 'WebSearch') {
          out.events.push({ channel: 'search', kind: 'search', text: `⌕ ${trunc(String(input?.query ?? ''), 200)}` })
        } else if (name === 'Bash') {
          out.events.push({ channel: 'tool', kind: 'cmd', text: `$ ${trunc(String(input?.command ?? ''), 200)}` })
        } else {
          out.events.push({ channel: 'tool', kind: 'tool', text: `→ ${name} ${input ? trunc(JSON.stringify(input), 160) : ''}` })
        }
      }
    }
    return out
  }
  if (type === 'user') {
    const message = obj.message as Record<string, unknown> | undefined
    const content = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : []
    for (const block of content) {
      if (block.type === 'tool_result' && block.is_error) {
        out.events.push({ channel: 'error', kind: 'error', text: `✗ tool error: ${trunc(JSON.stringify(block.content ?? ''), 300)}` })
      }
    }
    return out
  }
  if (type === 'result') {
    out.result = {
      text: typeof obj.result === 'string' ? obj.result : null,
      usage: (obj.usage as Record<string, number> | undefined) ?? undefined,
      isError: obj.is_error === true,
      subtype: typeof obj.subtype === 'string' ? obj.subtype : null,
      raw: obj,
    }
    return out
  }
  return out
}
