import { describe, expect, it } from 'vitest'
import type { AgentMetric, LoopLogLine } from '../../../shared/loop'
import { agentActive, agentDisplayStatus, logEmptyMessage, thoughtAvailabilityMessage } from './run-visibility'

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
})
