import { describe, expect, it } from 'vitest'
import type { AgentMetric, LoopLogLine } from '../../../shared/loop'
import { agentActive, agentRawStreamInput, logEmptyMessage, thoughtAvailabilityMessage } from './run-visibility'

const line: LoopLogLine = { loopId: 'l', runId: 'r', ts: '2026-09-02T00:00:00.000Z', kind: 'system', text: 'started' }

describe('run visibility helpers', () => {
  it('marks only recently active unfinished agents active', () => {
    const agent = { done: false, lastTs: '2026-09-02T00:00:30.000Z' } as AgentMetric
    expect(agentActive(agent, new Date('2026-09-02T00:01:00.000Z').getTime())).toBe(true)
    expect(agentActive({ ...agent, done: true }, new Date('2026-09-02T00:01:00.000Z').getTime())).toBe(false)
  })

  it('offers raw files only for agents with independent transcripts', () => {
    expect(agentRawStreamInput('run', 'child:physics')).toEqual({ runId: 'run', stream: 'agent', agentId: 'child:physics' })
    expect(agentRawStreamInput('run', 'wf:wf_build:a1')).not.toBeNull()
    expect(agentRawStreamInput('run', 'orchestrator')).toBeNull()
  })

  it('distinguishes waiting, filtered-empty, and unavailable thinking', () => {
    expect(logEmptyMessage([], [])).toBe('Waiting for output…')
    expect(logEmptyMessage([line], [])).toBe('No activity matches the selected filters.')
    expect(logEmptyMessage([line], [line])).toBeNull()
    expect(thoughtAvailabilityMessage([])).toContain('CLI did not emit')
    expect(thoughtAvailabilityMessage(['visible'])).toBeNull()
  })
})
