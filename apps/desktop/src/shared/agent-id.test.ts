import { describe, expect, it } from 'vitest'
import {
  childAgentMetricId,
  codexAgentMetricId,
  logAgentIdForMetric,
  parseAgentMetricId,
  workflowAgentMetricId,
} from './agent-id'

describe('agent metric ids', () => {
  it('parses every owned nested-stream convention from one shared grammar', () => {
    expect(parseAgentMetricId(childAgentMetricId('physics'))).toEqual({ kind: 'child', slug: 'physics' })
    expect(parseAgentMetricId(workflowAgentMetricId('wf_build', 'a1'))).toEqual({
      kind: 'workflow',
      runId: 'wf_build',
      agentId: 'a1',
    })
    expect(parseAgentMetricId(codexAgentMetricId('thread-1'))).toEqual({ kind: 'codex', threadId: 'thread-1' })
  })

  it('maps metric ids to log ids without accepting path syntax', () => {
    expect(logAgentIdForMetric('child:physics')).toBe('physics')
    expect(logAgentIdForMetric('wf:wf_build:a1')).toBe('wf:wf_build:a1')
    expect(logAgentIdForMetric('child:../escape')).toBeNull()
    expect(parseAgentMetricId('codex:../../escape')).toBeNull()
  })
})
