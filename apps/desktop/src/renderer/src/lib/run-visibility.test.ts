import { describe, expect, it } from 'vitest'
import type { AgentMetric, LoopLogLine, RunRecord } from '../../../shared/loop'
import { agentActive, agentDisplayStatus, logEmptyMessage, rawStreamForLogLine, rawStreamLinks, thoughtAvailabilityMessage } from './run-visibility'

const line: LoopLogLine = { loopId: 'l', runId: 'r', ts: '2026-09-02T00:00:00.000Z', kind: 'system', text: 'started' }

describe('run visibility helpers', () => {
  it('marks only recently active unfinished agents active', () => {
    const agent = { done: false, lastTs: '2026-09-02T00:00:30.000Z' } as AgentMetric
    expect(agentActive(agent, new Date('2026-09-02T00:01:00.000Z').getTime())).toBe(true)
    expect(agentActive({ ...agent, done: true }, new Date('2026-09-02T00:01:00.000Z').getTime())).toBe(false)
    expect(agentActive({ ...agent, state: 'failed' }, new Date('2026-09-02T00:01:00.000Z').getTime())).toBe(false)
    expect(agentDisplayStatus({ ...agent, state: 'failed', done: true })).toBe('failed')
  })

  it('distinguishes waiting, filtered-empty, and unavailable thinking', () => {
    expect(logEmptyMessage([], [])).toBe('Waiting for output…')
    expect(logEmptyMessage([line], [])).toBe('No activity matches the selected filters.')
    expect(logEmptyMessage([line], [line])).toBeNull()
    expect(thoughtAvailabilityMessage([])).toContain('CLI did not emit')
    expect(thoughtAvailabilityMessage(['visible'])).toBeNull()
  })

  it('links primary files and every separately owned delegated stream', () => {
    const run = {
      id: 'run-1',
      round: 2,
      role: 'implement',
      startedAt: '2026-09-02T01:00:00.000Z',
      metrics: {
        agents: [
          { id: 'orchestrator', label: 'Orchestrator' },
          { id: 'child:physics', label: 'Physics specialist', firstTs: '2026-09-02T01:01:00.000Z' },
          { id: 'wf:wf_123:agent_456', label: 'Workflow reviewer', firstTs: '2026-09-02T01:02:00.000Z' },
          { id: 'codex:thread_789', label: 'Codex implementer', firstTs: '2026-09-02T01:03:00.000Z' },
        ],
      },
    } as RunRecord

    expect(rawStreamLinks([run], [{ ...line, runId: 'run-1', ts: '2026-09-02T01:00:30.000Z', kind: 'stderr' }])).toEqual([
      { key: 'run-1:stdout', label: 'Round 2 implement output', ts: '2026-09-02T01:00:00.000Z', round: 2, role: 'implement', input: { runId: 'run-1', stream: 'stdout' } },
      { key: 'run-1:stderr', label: 'Round 2 implement error output', ts: '2026-09-02T01:00:30.000Z', round: 2, role: 'implement', input: { runId: 'run-1', stream: 'stderr' } },
      { key: 'run-1:agent:child:physics', label: 'Round 2 implement · Physics specialist', ts: '2026-09-02T01:01:00.000Z', agentId: 'physics', round: 2, role: 'implement', input: { runId: 'run-1', stream: 'agent', agentId: 'child:physics' } },
      { key: 'run-1:agent:wf:wf_123:agent_456', label: 'Round 2 implement · Workflow reviewer', ts: '2026-09-02T01:02:00.000Z', agentId: 'wf:wf_123:agent_456', round: 2, role: 'implement', input: { runId: 'run-1', stream: 'agent', agentId: 'wf:wf_123:agent_456' } },
      { key: 'run-1:agent:codex:thread_789', label: 'Round 2 implement · Codex implementer', ts: '2026-09-02T01:03:00.000Z', agentId: 'codex:thread_789', round: 2, role: 'implement', input: { runId: 'run-1', stream: 'agent', agentId: 'codex:thread_789' } },
    ])
  })

  it('does not advertise streams before the attempt or agent starts', () => {
    const run = { id: 'run-1', round: 1, role: 'implement', startedAt: null } as RunRecord
    expect(rawStreamLinks([run])).toEqual([])
  })

  it('does not add an error-stream entry when no stderr event occurred', () => {
    const run = { id: 'run-1', round: 1, role: 'implement', startedAt: '2026-09-02T01:00:00.000Z', error: null } as RunRecord
    expect(rawStreamLinks([run]).map((stream) => stream.input.stream)).toEqual(['stdout'])
  })

  it('attaches navigation to stream-open, stderr, and delegated-start log events only', () => {
    const streams = [
      { key: 'out', label: 'output', ts: line.ts, round: 1, role: 'implement' as const, input: { runId: 'r', stream: 'stdout' as const } },
      { key: 'err', label: 'errors', ts: line.ts, round: 1, role: 'implement' as const, input: { runId: 'r', stream: 'stderr' as const } },
      { key: 'child', label: 'child', ts: line.ts, agentId: 'physics', round: 1, role: 'implement' as const, input: { runId: 'r', stream: 'agent' as const, agentId: 'child:physics' } },
    ]
    expect(rawStreamForLogLine({ ...line, kind: 'raw-stream' }, streams)?.key).toBe('out')
    expect(rawStreamForLogLine({ ...line, kind: 'stderr' }, streams)?.key).toBe('err')
    expect(rawStreamForLogLine({ ...line, kind: 'spawn', agentId: 'physics', text: '⇉ worker started' }, streams)?.key).toBe('child')
    expect(rawStreamForLogLine({ ...line, kind: 'spawn', agentId: 'physics', text: '⇊ worker finished' }, streams)).toBeNull()
  })
})
