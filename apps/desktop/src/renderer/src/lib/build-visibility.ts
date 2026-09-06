import { logAgentIdForMetric, parseAgentMetricId } from '../../../shared/agent-id'
import type { AgentMetric, BuildLogLine, RawStreamInput, PhaseAttempt, PhaseRole } from '../../../shared/build'

export function agentActive(agent: AgentMetric, now = Date.now()): boolean {
  return agent.state !== 'failed' && !agent.done && agent.lastTs != null && now - new Date(agent.lastTs).getTime() < 90_000
}

export type AgentDisplayStatus = 'active' | 'failed' | 'done' | 'waiting'

export function agentDisplayStatus(agent: AgentMetric, now = Date.now()): AgentDisplayStatus {
  if (agent.state === 'failed') return 'failed'
  if (agentActive(agent, now)) return 'active'
  return agent.done ? 'done' : 'waiting'
}

export function logEmptyMessage(visibleLines: BuildLogLine[], filteredLines: BuildLogLine[]): string | null {
  if (filteredLines.length > 0) return null
  return visibleLines.length > 0 ? 'No activity matches the selected filters.' : 'Waiting for output…'
}

export function thoughtAvailabilityMessage(thoughts: readonly string[]): string | null {
  return thoughts.length === 0 ? 'Thought process unavailable for this build; the CLI did not emit thinking events.' : null
}

export interface RawStreamLink {
  key: string
  label: string
  ts: string
  agentId?: string
  round: number
  role: PhaseRole
  input: RawStreamInput
}

/** Timestamped navigation for each raw stream as its owning attempt or agent began. */
export function rawStreamLinks(attempts: readonly PhaseAttempt[], lines: readonly BuildLogLine[] = []): RawStreamLink[] {
  return attempts.flatMap((attempt) => {
    if (!attempt.startedAt) return []
    const label = `Round ${attempt.round} ${attempt.role}`
    const links: RawStreamLink[] = [
      { key: `${attempt.id}:stdout`, label: `${label} output`, ts: attempt.startedAt, round: attempt.round, role: attempt.role, input: { attemptId: attempt.id, stream: 'stdout' } },
    ]
    const firstStderr = lines.find((line) => line.attemptId === attempt.id && line.kind === 'stderr')
    const stderrTs = firstStderr?.ts ?? (attempt.error ? attempt.finishedAt : null)
    if (stderrTs) links.push({
      key: `${attempt.id}:stderr`,
      label: `${label} error output`,
      ts: stderrTs,
      round: attempt.round,
      role: attempt.role,
      input: { attemptId: attempt.id, stream: 'stderr' },
    })
    for (const agent of attempt.metrics?.agents ?? []) {
      if (!parseAgentMetricId(agent.id) || !agent.firstTs) continue
      links.push({
        key: `${attempt.id}:agent:${agent.id}`,
        label: `${label} · ${agent.label}`,
        ts: agent.firstTs,
        agentId: logAgentIdForMetric(agent.id) ?? undefined,
        round: attempt.round,
        role: attempt.role,
        input: { attemptId: attempt.id, stream: 'agent', agentId: agent.id },
      })
    }
    return links
  })
}

/** Attach raw navigation only to the timestamped event where that stream appeared. */
export function rawStreamForLogLine(line: BuildLogLine, streams: readonly RawStreamLink[]): RawStreamLink | null {
  if (line.kind === 'raw-stream' && line.attemptId) {
    return streams.find((stream) => stream.input.attemptId === line.attemptId && stream.input.stream === 'stdout') ?? null
  }
  if (line.kind === 'stderr' && line.attemptId) {
    return streams.find((stream) => stream.input.attemptId === line.attemptId && stream.input.stream === 'stderr') ?? null
  }
  if (line.kind === 'spawn' && line.agentId && line.text.trimStart().startsWith('⇉')) {
    return streams.find((stream) => stream.input.attemptId === line.attemptId && stream.agentId === line.agentId) ?? null
  }
  return null
}
