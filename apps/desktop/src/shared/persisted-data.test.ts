import { describe, expect, it } from 'vitest'
import { normalizeRunMetrics, normalizeVerdict } from './persisted-data'

describe('normalizeVerdict', () => {
  const valid = {
    score: 0.9,
    pass: true,
    summary: 'Faithful and polished.',
    findings: [{ severity: 'minor', text: 'One transition is abrupt.' }],
  }

  it('accepts the exact persisted verdict contract', () => {
    expect(normalizeVerdict(valid)).toEqual(valid)
  })

  it('redacts free-form verdict strings without changing score, pass, or severity', () => {
    const secret = `ghp_${'a'.repeat(36)}`
    expect(normalizeVerdict({
      score: 0.75,
      pass: false,
      summary: `summary ${secret}`,
      findings: [{ severity: 'major', text: `finding ${secret}` }],
    })).toEqual({
      score: 0.75,
      pass: false,
      summary: 'summary [REDACTED]',
      findings: [{ severity: 'major', text: 'finding [REDACTED]' }],
    })
  })

  it.each([
    { ...valid, score: '0.9' },
    { ...valid, score: 9 },
    { ...valid, pass: 'true' },
    { ...valid, findings: ['too dark'] },
    { ...valid, findings: [{ severity: 'note', text: 'too dark' }] },
    { ...valid, extra: true },
  ])('rejects malformed or coercible verdict %#', (value) => {
    expect(normalizeVerdict(value)).toBeNull()
  })
})

describe('normalizeRunMetrics', () => {
  it('normalizes additive cache token fields for an old row', () => {
    const metrics = normalizeRunMetrics({
      agents: [
        {
          id: 'orchestrator',
          label: 'orchestrator',
          model: 'claude-opus-5',
          messages: 1,
          tokens: { input: 10, output: 2 },
          firstTs: null,
          lastTs: null,
        },
      ],
      perModel: { 'claude-opus-5': { costUsd: 0.01, tokens: { input: 10, output: 2 } } },
    })

    expect(metrics?.agents[0].tokens).toEqual({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0 })
    expect(metrics?.perModel['claude-opus-5'].tokens).toEqual({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0 })
  })

  it('preserves bounded historical model labels without hiding the run', () => {
    const metrics = normalizeRunMetrics({
      agents: [
        {
          id: 'synthetic',
          label: 'synthetic',
          model: '<synthetic>',
          messages: 0,
          tokens: { input: 0, output: 0 },
          firstTs: null,
          lastTs: null,
        },
        {
          id: 'worker',
          label: 'worker',
          model: 'claude-opus-5[1m]',
          messages: 1,
          tokens: { input: 10, output: 2 },
          firstTs: null,
          lastTs: null,
        },
      ],
      perModel: { 'claude-opus-5[1m]': { costUsd: 0.01, tokens: { input: 10, output: 2 } } },
    })

    expect(metrics?.agents.map((agent) => agent.model)).toEqual(['<synthetic>', 'claude-opus-5[1m]'])
    expect(metrics?.perModel['claude-opus-5[1m]']).toEqual({
      costUsd: 0.01,
      tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
    })
  })

  it('normalizes a bounded durable transcript projection cursor', () => {
    const metrics = normalizeRunMetrics({
      agents: [],
      perModel: {},
      projection: {
        loggedOutLines: 12,
        loggedErrLines: 3,
        childOffsets: { 'worker-1.claude.jsonl': 42 },
        childIdentities: { 'worker-1.claude.jsonl': { dev: 1, ino: 2 } },
        workflowOffsets: { 'wf_run-1/journal.jsonl': 9, 'wf_run-1/agent-agent_1.jsonl': 17 },
        workflowIdentities: {
          'wf_run-1/journal.jsonl': { dev: 3, ino: 4 },
          'wf_run-1/agent-agent_1.jsonl': { dev: 5, ino: 6 },
        },
      },
    })
    expect(metrics?.projection).toEqual({
      loggedOutLines: 12,
      loggedErrLines: 3,
      childOffsets: { 'worker-1.claude.jsonl': 42 },
      childIdentities: { 'worker-1.claude.jsonl': { dev: 1, ino: 2 } },
      workflowOffsets: { 'wf_run-1/agent-agent_1.jsonl': 17, 'wf_run-1/journal.jsonl': 9 },
      workflowIdentities: {
        'wf_run-1/agent-agent_1.jsonl': { dev: 5, ino: 6 },
        'wf_run-1/journal.jsonl': { dev: 3, ino: 4 },
      },
    })
  })

  it('redacts free-form agent fields without changing accounting data', () => {
    const secret = `ghp_${'a'.repeat(36)}`
    const metrics = normalizeRunMetrics({
      agents: [{
        id: 'child:worker',
        label: `worker ${secret}`,
        model: 'claude-opus-5',
        messages: 7,
        tokens: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 },
        firstTs: '2026-09-02T00:00:00.000Z',
        lastTs: '2026-09-02T00:01:00.000Z',
        prompt: `implement ${secret}`,
        note: `note ${secret}`,
        lastTool: `tool ${secret}`,
        costUsd: 1.25,
      }],
      perModel: {
        'claude-opus-5': { costUsd: 1.25, tokens: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 } },
      },
    })

    expect(metrics?.agents[0]).toEqual(expect.objectContaining({
      label: 'worker [REDACTED]',
      prompt: 'implement [REDACTED]',
      note: 'note [REDACTED]',
      lastTool: 'tool [REDACTED]',
      messages: 7,
      tokens: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 },
      costUsd: 1.25,
    }))
    expect(metrics?.perModel['claude-opus-5']).toEqual({
      costUsd: 1.25,
      tokens: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 },
    })
  })

  it('redacts credential-shaped model identifiers without losing per-model accounting', () => {
    const secretModel = `ghp_${'b'.repeat(36)}`
    const metrics = normalizeRunMetrics({
      agents: [{
        id: 'orchestrator', label: 'orchestrator', model: secretModel, messages: 1,
        tokens: { input: 19, output: 3, cacheRead: 2, cacheWrite: 1 }, firstTs: null, lastTs: null,
      }],
      perModel: {
        [secretModel]: { costUsd: 0.75, tokens: { input: 19, output: 3, cacheRead: 2, cacheWrite: 1 } },
      },
    })

    expect(metrics?.agents[0].model).toBe('[REDACTED]')
    expect(metrics?.perModel['[REDACTED]']).toEqual({
      costUsd: 0.75,
      tokens: { input: 19, output: 3, cacheRead: 2, cacheWrite: 1 },
    })
    expect(JSON.stringify(metrics)).not.toContain(secretModel)
  })

  it('redacts a credential-shaped agent identifier while preserving the row', () => {
    const secretId = `sk-proj-${'e'.repeat(24)}`
    const metrics = normalizeRunMetrics({
      agents: [{
        id: secretId, label: 'provider agent', model: null, messages: 1,
        tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, firstTs: null, lastTs: null,
      }],
      perModel: {},
    })
    expect(metrics?.agents[0]).toMatchObject({ id: '[REDACTED]', label: 'provider agent', messages: 1 })
    expect(JSON.stringify(metrics)).not.toContain(secretId)
  })

  it.each([
    { agents: 'many', perModel: {} },
    { agents: [], perModel: [] },
    { agents: [], perModel: { model: { costUsd: -1, tokens: { input: 1, output: 1 } } } },
    { agents: [{ id: 'a', label: 'a', model: null, messages: 1, tokens: { input: -1, output: 0 }, firstTs: null, lastTs: null }], perModel: {} },
    { agents: [{ id: 'a', label: 'a', model: null, messages: 1.5, tokens: { input: 1, output: 0 }, firstTs: null, lastTs: null }], perModel: {} },
    { agents: [{ id: 'a', label: 'a', model: null, messages: 1, tokens: { input: Number.MAX_SAFE_INTEGER + 1, output: 0 }, firstTs: null, lastTs: null }], perModel: {} },
    { agents: [{ id: 'a', label: 'a', model: null, messages: 1, tokens: { input: 1, output: 0 }, firstTs: 'not-a-date', lastTs: null }], perModel: {} },
    { agents: [{ id: 'a', label: 'a', model: null, messages: 1, tokens: { input: 1, output: 0 }, firstTs: null, lastTs: '2026-09-02' }], perModel: {} },
    { agents: [], perModel: {}, projection: { loggedOutLines: 1, loggedErrLines: 0, childOffsets: { '../escape': 1 }, workflowOffsets: {} } },
    { agents: [], perModel: {}, projection: { loggedOutLines: 1, loggedErrLines: 0, childOffsets: {}, workflowOffsets: { 'wf_x/journal.jsonl': -1 } } },
  ])('rejects malformed metrics %#', (value) => {
    expect(normalizeRunMetrics(value)).toBeNull()
  })
})
