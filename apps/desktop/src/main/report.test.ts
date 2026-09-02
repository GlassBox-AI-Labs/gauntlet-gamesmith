import { describe, expect, it } from 'vitest'
import type { LoopRecord, RunRecord } from '../shared/loop'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { buildReport } from './report'

const loop: LoopRecord = {
  id: 'l1',
  title: 'Pac-man',
  prompt: 'Build Pac-Man at AAA quality',
  workspaceDir: '/tmp/w',
  maxRounds: 10,
  budgetUsd: 100,
  models: resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'claude-opus-5', subagentEffort: 'medium' }, DEFAULT_CRITIC),
  status: 'running',
  round: 2,
  totalCostUsd: 12.5,
  stopReason: null,
  createdAt: '2026-08-30T20:00:00.000Z',
  updatedAt: '2026-08-30T21:00:00.000Z',
}

function run(partial: Partial<RunRecord>): RunRecord {
  return {
    id: 'r',
    loopId: 'l1',
    round: 1,
    role: 'implement',
    harness: 'claude',
    status: 'succeeded',
    prompt: 'p',
    model: 'claude-fable-5',
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
    createdAt: '2026-08-30T20:00:01.000Z',
    startedAt: null,
    finishedAt: '2026-08-30T20:30:00.000Z',
    ...partial,
  }
}

describe('buildReport', () => {
  it('sums cost and tokens across finished runs and shows the score trend', () => {
    const report = buildReport(loop, [
      run({ id: 'a', costUsd: 10, inputTokens: 1_500_000, outputTokens: 90_000, durationMs: 8 * 60_000 }),
      run({
        id: 'b',
        role: 'critique',
        harness: 'codex',
        model: 'gpt-5.6-sol',
        inputTokens: 500_000,
        outputTokens: 10_000,
        verdict: { score: 0.42, pass: false, summary: 'Not AAA yet', findings: [{ severity: 'major', text: 'flat lighting' }] },
      }),
      run({ id: 'c', round: 2, status: 'queued', costUsd: 999 }),
    ])
    expect(report).toContain('**Equivalent cost:** $10.00 of $100.00 budget')
    expect(report).toContain('in 2.00M / out 100.0k')
    expect(report).toContain('| Runtime | Score |')
    // Per-attempt runtime, not time-since-loop-start: this run took 8m of the 30m elapsed.
    expect(report).toContain('| 8m00s |')
    expect(report).toContain('0.42')
    expect(report).toContain('flat lighting')
  })

  it('handles a loop with no verdicts yet', () => {
    const report = buildReport(loop, [run({ id: 'a', status: 'running' })])
    expect(report).toContain('Gauntlet Loop report')
    expect(report).not.toContain('Score trend')
  })

  it('shows the Reference Study as a pre-round result', () => {
    const report = buildReport(loop, [run({ role: 'reference', round: 0 })], [], {
      root: 'reference/l1',
      ready: true,
      issues: [],
      images: Array.from({ length: 8 }, (_, index) => `reference/l1/images/${index}.jpg`),
      motion: Array.from({ length: 8 }, (_, index) => `reference/l1/motion/${index}.jpg`),
      videos: ['reference/l1/video/gameplay.webm'],
      journey: Array.from({ length: 4 }, (_, index) => `reference/l1/journey/0${index + 1}-shot.png`),
      readme: '# Visual target',
      manifest: '{}',
      journeyMd: '# Walkthrough',
      storyMd: '# Premise',
      researchMd: '# What players say',
    })
    expect(report).toContain('| — | reference |')
    expect(report).toContain('## Reference Pack')
    expect(report).toContain('8 stills · 8 motion frames · 4 journey shots · 1 videos')
    expect(report).toContain('# Visual target')
  })
})
