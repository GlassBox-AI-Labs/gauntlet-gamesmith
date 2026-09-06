import { describe, expect, it } from 'vitest'
import type { BuildLogLine } from '../../../shared/build'
import { agentFilterKey, lineMatchesFilter, logLineColor, PRIMARY_AGENT, roundChipLabel } from './log-filter'

const line: BuildLogLine = {
  buildId: 'build',
  attemptId: 'build',
  ts: '2026-09-02T12:00:00.000Z',
  kind: 'thought',
  channel: 'thought',
  text: 'thinking',
  round: 2,
  agentId: 'child',
}

describe('log filter helpers', () => {
  it('filters solely from denormalized line fields', () => {
    expect(lineMatchesFilter(line, { round: null, agent: null })).toBe(true)
    expect(lineMatchesFilter(line, { round: 1, agent: null })).toBe(false)
    expect(lineMatchesFilter(line, { round: 2, agent: 'child' })).toBe(true)
    expect(lineMatchesFilter({ ...line, agentId: undefined }, { round: 2, agent: PRIMARY_AGENT })).toBe(true)
  })

  it('maps metrics to their durable agent ids and formats presentation metadata', () => {
    expect(agentFilterKey('child:physics')).toBe('physics')
    expect(agentFilterKey('wf:wf_build:a1')).toBe('wf:wf_build:a1')
    expect(agentFilterKey('codex:thread')).toBe('codex:thread')
    expect(agentFilterKey('toolu_native_agent')).toBe('toolu_native_agent')
    expect(agentFilterKey('orchestrator')).toBe(PRIMARY_AGENT)
    expect(roundChipLabel(0)).toBe('Ref')
    expect(logLineColor(line)).toContain('a99bc4')
  })
})
