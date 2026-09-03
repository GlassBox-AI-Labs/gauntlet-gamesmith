import { codexAgentMetricId } from '../../shared/agent-id'
import { normalizeSessionId } from '../../shared/session-id'
import { normalizeStreamUsage, trunc, type StreamEvent } from './claude-stream'

export interface CodexLineResult {
  events: StreamEvent[]
  /** Present when this line was the thread.started event. */
  threadStarted?: string | null
  /** Last agent_message text on this line — the summary candidate. */
  summary?: string
  /** Present on turn.completed; usage may still be absent on a failed read. */
  turn?: { usage?: Record<string, number> }
  /** Failure message from turn.failed. */
  error?: string
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

function systemEvent(label: string, value: unknown): StreamEvent {
  return { channel: 'system', kind: 'system', text: `unhandled codex ${label}: ${excerpt(value)}` }
}

function nestedAgentId(item: Record<string, unknown>): string | undefined {
  const value = item.agent_id ?? item.new_thread_id ?? item.receiver_agent_id
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? codexAgentMetricId(value) : undefined
}

export function translateCodexLine(line: string): CodexLineResult | null {
  if (!line.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { events: [systemEvent('non-JSON line', line)] }
  }
  if (!isRecord(parsed)) return { events: [systemEvent('malformed event', parsed)] }
  const obj = parsed
  const out: CodexLineResult = { events: [] }
  const type = typeof obj.type === 'string' ? obj.type : 'unknown'
  if (type === 'thread.started') {
    out.threadStarted = normalizeSessionId(obj.thread_id)
    return out
  }
  if (type === 'item.completed') {
    const item = isRecord(obj.item) ? obj.item : null
    if (!item) {
      out.events.push(systemEvent('item.completed without an item', obj))
      return out
    }
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      out.summary = item.text
      out.events.push({ channel: 'output', kind: 'codex', text: trunc(item.text, 400) })
    } else if (item.type === 'reasoning' && typeof item.text === 'string' && item.text.trim()) {
      out.events.push({ channel: 'thought', kind: 'thought', text: `𝜓 ${trunc(item.text, 500)}` })
    } else if (item.type === 'command_execution' && typeof item.command === 'string') {
      out.events.push({ channel: 'tool', kind: 'cmd', text: `$ ${trunc(item.command, 200)}` })
      if ((typeof item.exit_code === 'number' && item.exit_code !== 0) || item.status === 'failed') {
        const detail = typeof item.aggregated_output === 'string' && item.aggregated_output.trim()
          ? `: ${trunc(item.aggregated_output, 240)}`
          : ''
        out.events.push({
          channel: 'error',
          kind: 'error',
          text: `command ${item.status === 'failed' ? 'failed' : `exited ${item.exit_code}`}${detail}`,
        })
      }
    } else if (item.type === 'web_search') {
      out.events.push({ channel: 'search', kind: 'search', text: `⌕ ${trunc(String(item.query ?? ''), 200)}` })
    } else if (item.type === 'file_change') {
      out.events.push({ channel: 'tool', kind: 'cmd', text: `✎ ${trunc(JSON.stringify(item.changes ?? ''), 160)}` })
    } else if (item.type === 'SubAgentActivity' || item.type === 'collab_tool_call') {
      const nestedId = nestedAgentId(item)
      const label = item.agent_id ?? item.new_thread_id ?? item.receiver_agent_id ?? item.agent_path ?? item.id ?? item.kind ?? 'unknown'
      const finished = item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled'
      out.events.push({
        channel: 'tool',
        kind: 'spawn',
        text: `${finished ? '⇊' : '⇉'} worker ${trunc(JSON.stringify(label), 120)}${finished ? ` ${String(item.status)}` : ''}`,
        ...(nestedId ? { agentId: nestedId } : {}),
      })
    } else if (item.type === 'mcp_tool_call') {
      out.events.push({ channel: 'tool', kind: 'tool', text: `→ MCP ${trunc(String(item.server ?? item.name ?? ''), 80)} ${excerpt(item.arguments ?? item.input ?? '')}` })
    } else if (item.type === 'todo_list') {
      out.events.push({ channel: 'tool', kind: 'tool', text: `☑ ${excerpt(item.items ?? item)}` })
    } else if (item.type === 'error') {
      out.events.push({ channel: 'error', kind: 'error', text: trunc(String(item.message ?? 'codex error'), 300) })
    } else {
      out.events.push(systemEvent(`item "${String(item.type ?? 'unknown')}"`, item))
    }
    return out
  }
  if (type === 'turn.completed') {
    out.turn = { usage: normalizeStreamUsage(obj.usage) }
    return out
  }
  if (type === 'turn.failed') {
    const error = isRecord(obj.error) ? obj.error : null
    out.error = String(error?.message ?? 'codex turn failed')
    out.events.push({ channel: 'error', kind: 'error', text: out.error })
    return out
  }
  if (type === 'error') {
    const error = isRecord(obj.error) ? obj.error : null
    out.error = String(obj.message ?? error?.message ?? 'codex stream error')
    out.events.push({ channel: 'error', kind: 'error', text: trunc(out.error, 300) })
    return out
  }
  out.events.push(systemEvent(`event "${type}"`, obj))
  return out
}
