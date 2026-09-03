import type { AgentMetric, LoopLogLine, RevealStreamInput } from '../../../shared/loop'
import { parseAgentMetricId } from '../../../shared/agent-id'

export function agentActive(agent: AgentMetric, now = Date.now()): boolean {
  return !agent.done && agent.lastTs != null && now - new Date(agent.lastTs).getTime() < 90_000
}

/** Only agents backed by their own file get a raw-stream action. */
export function agentRawStreamInput(runId: string, agentId: string): RevealStreamInput | null {
  if (!parseAgentMetricId(agentId)) return null
  return { runId, stream: 'agent', agentId }
}

export function logEmptyMessage(visibleLines: LoopLogLine[], filteredLines: LoopLogLine[]): string | null {
  if (filteredLines.length > 0) return null
  return visibleLines.length > 0 ? 'No activity matches the selected filters.' : 'Waiting for output…'
}

export function thoughtAvailabilityMessage(thoughts: readonly string[]): string | null {
  return thoughts.length === 0 ? 'Thought process unavailable for this run; the CLI did not emit thinking events.' : null
}
