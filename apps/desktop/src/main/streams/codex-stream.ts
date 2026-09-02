import { trunc, type StreamEvent } from './claude-stream'

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

export function translateCodexLine(line: string): CodexLineResult | null {
  if (!line.trim()) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const out: CodexLineResult = { events: [] }
  const type = obj.type as string
  if (type === 'thread.started') {
    out.threadStarted = (obj.thread_id as string | undefined) ?? null
    return out
  }
  if (type === 'item.completed') {
    const item = obj.item as Record<string, unknown> | undefined
    if (!item) return out
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      out.summary = item.text
      out.events.push({ channel: 'output', kind: 'codex', text: trunc(item.text, 400) })
    } else if (item.type === 'reasoning' && typeof item.text === 'string' && item.text.trim()) {
      out.events.push({ channel: 'thought', kind: 'thought', text: `𝜓 ${trunc(item.text, 500)}` })
    } else if (item.type === 'command_execution' && typeof item.command === 'string') {
      out.events.push({ channel: 'tool', kind: 'cmd', text: `$ ${trunc(item.command, 200)}` })
    } else if (item.type === 'web_search') {
      out.events.push({ channel: 'search', kind: 'search', text: `⌕ ${trunc(String(item.query ?? ''), 200)}` })
    } else if (item.type === 'file_change') {
      out.events.push({ channel: 'tool', kind: 'cmd', text: `✎ ${trunc(JSON.stringify(item.changes ?? ''), 160)}` })
    } else if (item.type === 'SubAgentActivity' || item.type === 'collab_tool_call') {
      out.events.push({ channel: 'tool', kind: 'spawn', text: `⇉ worker ${trunc(JSON.stringify(item.agent_path ?? item.kind ?? ''), 120)}` })
    } else if (item.type === 'error') {
      out.events.push({ channel: 'error', kind: 'error', text: trunc(String(item.message ?? 'codex error'), 300) })
    }
    return out
  }
  if (type === 'turn.completed') {
    out.turn = { usage: (obj.usage as Record<string, number> | undefined) ?? undefined }
    return out
  }
  if (type === 'turn.failed') {
    out.error = String((obj.error as Record<string, unknown> | undefined)?.message ?? 'codex turn failed')
    return out
  }
  return out
}
