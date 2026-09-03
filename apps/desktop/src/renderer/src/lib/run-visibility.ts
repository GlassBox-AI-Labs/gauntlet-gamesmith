import type { AgentMetric, LoopLogLine } from '../../../shared/loop'

export function agentActive(agent: AgentMetric, now = Date.now()): boolean {
  return agent.state !== 'failed' && !agent.done && agent.lastTs != null && now - new Date(agent.lastTs).getTime() < 90_000
}

export type AgentDisplayStatus = 'active' | 'failed' | 'done' | 'waiting'

export function agentDisplayStatus(agent: AgentMetric, now = Date.now()): AgentDisplayStatus {
  if (agent.state === 'failed') return 'failed'
  if (agentActive(agent, now)) return 'active'
  return agent.done ? 'done' : 'waiting'
}

export function logEmptyMessage(visibleLines: LoopLogLine[], filteredLines: LoopLogLine[]): string | null {
  if (filteredLines.length > 0) return null
  return visibleLines.length > 0 ? 'No activity matches the selected filters.' : 'Waiting for output…'
}

export function thoughtAvailabilityMessage(thoughts: readonly string[]): string | null {
  return thoughts.length === 0 ? 'Thought process unavailable for this run; the CLI did not emit thinking events.' : null
}
