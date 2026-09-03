import { describe, expect, it } from 'vitest'
import type { LoopLogLine, RunRecord } from '../shared/loop'
import { withPromptLogs } from './prompt-logs'

function run(prompt: string): RunRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    loopId: '22222222-2222-4222-8222-222222222222',
    round: 1,
    role: 'implement',
    harness: 'claude',
    status: 'running',
    prompt,
    model: null,
    effort: null,
    cliVersion: null,
    priceTableVersion: null,
    costSource: null,
    promptSha256: null,
    accountLabel: null,
    machineLabel: null,
    authMode: null,
    summary: null,
    verdict: null,
    metrics: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: null,
    durationMs: null,
    sessionId: null,
    revision: null,
    error: null,
    createdAt: '2026-09-03T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
  }
}

describe('withPromptLogs', () => {
  it('projects the complete persisted prompt when legacy history has no prompt event', () => {
    const record = run('build the game')
    const event: LoopLogLine = {
      loopId: record.loopId,
      runId: record.id,
      ts: record.createdAt,
      kind: 'system',
      channel: 'system',
      text: 'started',
    }
    expect(withPromptLogs([record], [event]).map((line) => line.kind)).toEqual(['prompt', 'system'])
    expect(withPromptLogs([record], [event])[0].text).toContain('build the game')
  })

  it('projects one timestamped raw-stream entry for a legacy started attempt', () => {
    const record = { ...run('build the game'), startedAt: '2026-09-03T00:01:00.000Z' }
    const projected = withPromptLogs([record], [])
    expect(projected.filter((line) => line.kind === 'raw-stream')).toEqual([expect.objectContaining({
      runId: record.id,
      ts: record.startedAt,
      text: 'Raw output stream opened for this attempt.',
    })])
  })

  it('replaces a partial bounded-tail projection with every prompt chunk', () => {
    const record = run('x'.repeat(7_500))
    const partial: LoopLogLine = {
      loopId: record.loopId,
      runId: record.id,
      ts: record.createdAt,
      kind: 'prompt',
      channel: 'prompt',
      text: 'Implement prompt (3/3):\npartial',
    }
    const projected = withPromptLogs([record], [partial])
    expect(projected).toHaveLength(3)
    expect(projected.map((line) => line.text.match(/\((\d)\/3\)/)?.[1])).toEqual(['1', '2', '3'])
    expect(projected.map((line) => line.text.split('\n').slice(1).join('\n')).join('')).toBe(record.prompt)
  })

  it('redacts before chunking so a secret cannot straddle projected records', () => {
    const record = run(`goal\nAWS_SECRET_ACCESS_KEY=${'s'.repeat(4_000)}`)
    const projected = withPromptLogs([record], [])
    expect(projected).toHaveLength(1)
    expect(projected[0].text).toContain('[REDACTED]')
    expect(projected[0].text).not.toContain('s'.repeat(100))
  })

  it('does not materialize prompts for runs outside the bounded event response', () => {
    const records = Array.from({ length: 100 }, (_, index) => ({
      ...run('x'.repeat(100_000)),
      id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
    }))
    expect(withPromptLogs(records, [])).toEqual([])
  })

  it('caps reconstruction across represented runs and points to the Prompt browser', () => {
    const records = [
      { ...run('a'.repeat(300_000)), id: '11111111-1111-4111-8111-111111111111' },
      { ...run('b'.repeat(300_000)), id: '33333333-3333-4333-8333-333333333333' },
    ]
    const source = records.map((record): LoopLogLine => ({
      loopId: record.loopId,
      runId: record.id,
      ts: record.createdAt,
      kind: 'system',
      channel: 'system',
      text: 'represented',
    }))
    const projected = withPromptLogs(records, source)
    expect(projected.filter((line) => line.kind === 'prompt')).toHaveLength(Math.ceil(300_000 / 3_600))
    expect(projected.at(-1)?.text).toMatch(/Prompt browser/)
  })
})
