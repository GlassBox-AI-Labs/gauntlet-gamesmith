import { logAgentIdForMetric, parseAgentMetricId } from '../../../shared/agent-id'
import type { AgentMetric, LoopLogLine, RawStreamInput, RunRecord, RunRole } from '../../../shared/loop'

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

export interface RawStreamLink {
  key: string
  label: string
  ts: string
  agentId?: string
  round: number
  role: RunRole
  input: RawStreamInput
}

/** Timestamped navigation for each raw stream as its owning attempt or agent began. */
export function rawStreamLinks(runs: readonly RunRecord[], lines: readonly LoopLogLine[] = []): RawStreamLink[] {
  return runs.flatMap((run) => {
    if (!run.startedAt) return []
    const attempt = `Round ${run.round} ${run.role}`
    const links: RawStreamLink[] = [
      { key: `${run.id}:stdout`, label: `${attempt} output`, ts: run.startedAt, round: run.round, role: run.role, input: { runId: run.id, stream: 'stdout' } },
    ]
    const firstStderr = lines.find((line) => line.runId === run.id && line.kind === 'stderr')
    const stderrTs = firstStderr?.ts ?? (run.error ? run.finishedAt : null)
    if (stderrTs) links.push({
      key: `${run.id}:stderr`,
      label: `${attempt} error output`,
      ts: stderrTs,
      round: run.round,
      role: run.role,
      input: { runId: run.id, stream: 'stderr' },
    })
    for (const agent of run.metrics?.agents ?? []) {
      if (!parseAgentMetricId(agent.id) || !agent.firstTs) continue
      links.push({
        key: `${run.id}:agent:${agent.id}`,
        label: `${attempt} · ${agent.label}`,
        ts: agent.firstTs,
        agentId: logAgentIdForMetric(agent.id) ?? undefined,
        round: run.round,
        role: run.role,
        input: { runId: run.id, stream: 'agent', agentId: agent.id },
      })
    }
    return links
  })
}

/** Attach raw navigation only to the timestamped event where that stream appeared. */
export function rawStreamForLogLine(line: LoopLogLine, streams: readonly RawStreamLink[]): RawStreamLink | null {
  if (line.kind === 'raw-stream' && line.runId) {
    return streams.find((stream) => stream.input.runId === line.runId && stream.input.stream === 'stdout') ?? null
  }
  if (line.kind === 'stderr' && line.runId) {
    return streams.find((stream) => stream.input.runId === line.runId && stream.input.stream === 'stderr') ?? null
  }
  if (line.kind === 'spawn' && line.agentId && line.text.trimStart().startsWith('⇉')) {
    return streams.find((stream) => stream.input.runId === line.runId && stream.agentId === line.agentId) ?? null
  }
  return null
}
