import { describe, expect, it } from 'vitest'
import type { LoopRecord, LoopSnapshot, RunRecord } from '../shared/loop'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { hasMixedPrompts, REPORT_FILE_KIND, reportTotals, shortHash } from '../shared/reports'
import { buildReportRow, hashPrompt, parseReportFile, renderReportMarkdown, reportFileBase, toReportFile } from './reports'

const loop: LoopRecord = {
  id: 'l1',
  title: 'Pac-man',
  prompt: 'Build Pac-Man at AAA quality',
  workspaceDir: '/tmp/w',
  maxRounds: 10,
  budgetUsd: 100,
  models: resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'claude-opus-5', subagentEffort: 'medium' }, DEFAULT_CRITIC),
  status: 'passed',
  round: 2,
  totalCostUsd: 12.5,
  stopReason: 'Critic passed the build in round 2.',
  playTrusted: true,
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
    createdAt: '2026-08-30T20:00:01.000Z',
    startedAt: '2026-08-30T20:00:01.000Z',
    finishedAt: '2026-08-30T20:30:00.000Z',
    ...partial,
  }
}

const snapshot: LoopSnapshot = {
  loop,
  runs: [
    run({ id: 'a', costUsd: 6, inputTokens: 1_500_000, outputTokens: 90_000, durationMs: 1_800_000, revision: 'abcdef1234567890' }),
    run({
      id: 'b',
      role: 'critique',
      harness: 'codex',
      model: 'gpt-5.6-sol',
      costUsd: 1,
      inputTokens: 500_000,
      outputTokens: 10_000,
      durationMs: 300_000,
      verdict: { score: 0.62, pass: false, summary: 'Close', findings: [] },
      finishedAt: '2026-08-30T20:35:00.000Z',
    }),
    run({ id: 'c', round: 2, costUsd: 5, inputTokens: 900_000, outputTokens: 50_000, durationMs: 900_000 }),
    run({
      id: 'd',
      round: 2,
      role: 'critique',
      harness: 'codex',
      model: 'gpt-5.6-sol',
      costUsd: 0.5,
      inputTokens: 200_000,
      outputTokens: 8_000,
      durationMs: 120_000,
      verdict: { score: 0.91, pass: true, summary: 'Ships', findings: [] },
      finishedAt: '2026-08-30T21:00:00.000Z',
    }),
    run({ id: 'e', round: 3, status: 'queued', costUsd: 99, finishedAt: null }),
  ],
}

describe('hashPrompt', () => {
  it('ignores whitespace and the resume marker, so the same brief always matches', () => {
    expect(hashPrompt('Build   Pac-Man\n at AAA quality ')).toBe(hashPrompt('Build Pac-Man at AAA quality'))
    expect(hashPrompt('[[gauntlet:resume]]\nBuild Pac-Man')).toBe(hashPrompt('Build Pac-Man'))
  })

  it('separates different briefs', () => {
    expect(hashPrompt('Build Pac-Man')).not.toBe(hashPrompt('Build Tetris'))
  })
})

describe('buildReportRow', () => {
  const row = buildReportRow(snapshot)

  it('folds each round together and leaves queued attempts out', () => {
    expect(row.rounds.map((round) => round.round)).toEqual([1, 2])
    expect(row.roundsUsed).toBe(2)
    // The queued round-3 attempt carries a $99 cost that must not be counted.
    expect(row.costUsd).toBe(12.5)
    expect(row.inputTokens).toBe(3_100_000)
    expect(row.outputTokens).toBe(158_000)
  })

  it('records the best score and the round the critic first passed', () => {
    expect(row.bestScore).toBe(0.91)
    expect(row.finalScore).toBe(0.91)
    expect(row.passedAtRound).toBe(2)
    expect(row.rounds[0].pass).toBe(false)
    expect(row.rounds[1].pass).toBe(true)
  })

  it('reports wall clock and active time separately', () => {
    // 20:00 to 21:00 on the clock, but only 52 minutes inside attempts.
    expect(row.wallClockMs).toBe(3_600_000)
    expect(row.activeMs).toBe(3_120_000)
  })

  it('copies the setup and prompt hash in, so the row stands on its own', () => {
    expect(row.promptHash).toBe(hashPrompt(loop.prompt))
    expect(row.models.orchestratorModel).toBe('claude-fable-5')
    expect(row.models.criticModel).toBe(DEFAULT_CRITIC.criticModel)
    expect(row.title).toBe('Pac-man')
    expect(row.stopReason).toBe('Critic passed the build in round 2.')
    expect(row.rounds[0].revision).toBe('abcdef1234567890')
  })

  it('leaves cache token counts null when no run recorded a per-model split', () => {
    expect(row.cacheReadTokens).toBeNull()
    expect(row.cacheWriteTokens).toBeNull()
  })

  it('adds up cache reads and writes when the per-model split survived', () => {
    const withMetrics = buildReportRow({
      loop,
      runs: [
        run({
          id: 'a',
          metrics: {
            agents: [],
            perModel: {
              'claude-opus-5': { costUsd: 4, tokens: { input: 100, output: 20, cacheRead: 900, cacheWrite: 300 } },
              'gpt-5.6-sol': { costUsd: 1, tokens: { input: 50, output: 10, cacheRead: 100, cacheWrite: 0 } },
            },
          },
        }),
      ],
    })
    expect(withMetrics.cacheReadTokens).toBe(1000)
    expect(withMetrics.cacheWriteTokens).toBe(300)
  })
})

describe('report totals and prompt grouping', () => {
  it('adds rows up and spots a report that mixes briefs', () => {
    const a = buildReportRow(snapshot)
    const b = buildReportRow({ ...snapshot, loop: { ...loop, id: 'l2', prompt: 'Build Tetris' } })
    expect(hasMixedPrompts([a, a])).toBe(false)
    expect(hasMixedPrompts([a, b])).toBe(true)
    const totals = reportTotals([a, b])
    expect(totals.runs).toBe(2)
    expect(totals.rounds).toBe(4)
    expect(totals.costUsd).toBe(25)
  })
})

describe('renderReportMarkdown', () => {
  const report = {
    id: 'rep1',
    name: 'Opus vs Fable',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    capturedAt: '2026-09-01T00:00:00.000Z',
    rows: [buildReportRow(snapshot)],
  }

  it('names the report and shows the setup, results, and round detail', () => {
    const md = renderReportMarkdown(report)
    expect(md).toContain('# Opus vs Fable')
    expect(md).toContain('## Setup')
    expect(md).toContain('## Results')
    expect(md).toContain(shortHash(hashPrompt(loop.prompt)))
    expect(md).toContain('$12.50')
    expect(md).toContain('0.91')
  })

  it('warns when the runs did not share a prompt', () => {
    const mixed = { ...report, rows: [...report.rows, buildReportRow({ ...snapshot, loop: { ...loop, id: 'l2', prompt: 'Build Tetris' } })] }
    expect(renderReportMarkdown(mixed)).toContain('These runs used different prompts.')
    expect(renderReportMarkdown(report)).not.toContain('These runs used different prompts.')
  })

  it('says so plainly when the report is empty', () => {
    expect(renderReportMarkdown({ ...report, rows: [] })).toContain('no runs in it yet')
  })

  it('escapes a pipe in a run title rather than splitting the column', () => {
    const piped = { ...report, rows: [{ ...report.rows[0], title: 'A | B' }] }
    expect(renderReportMarkdown(piped)).toContain('A \\| B')
  })
})

describe('report files', () => {
  const report = {
    id: 'rep1',
    name: 'Opus vs Fable',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    capturedAt: '2026-09-01T00:00:00.000Z',
    rows: [buildReportRow(snapshot)],
  }

  it('round-trips a report through the export format', () => {
    const text = JSON.stringify(toReportFile(report, '2026-09-01T01:00:00.000Z'))
    expect(JSON.parse(text).kind).toBe(REPORT_FILE_KIND)
    const parsed = parseReportFile(text)
    expect(parsed.name).toBe('Opus vs Fable')
    expect(parsed.rows[0].bestScore).toBe(0.91)
    expect(parsed.rows[0].rounds).toHaveLength(2)
  })

  it('refuses files that are not reports, and reports from a newer app', () => {
    expect(() => parseReportFile('not json')).toThrow(/not valid JSON/)
    expect(() => parseReportFile('{"kind":"something-else"}')).toThrow(/not a Gauntlet Gamesmith report/)
    expect(() => parseReportFile(JSON.stringify({ kind: REPORT_FILE_KIND, version: 99, report }))).toThrow(/newer version/)
    expect(() => parseReportFile(JSON.stringify({ kind: REPORT_FILE_KIND, version: 1, report: { name: 'x' } }))).toThrow(/no name or no runs/)
    expect(() =>
      parseReportFile(JSON.stringify({ kind: REPORT_FILE_KIND, version: 1, report: { ...report, rows: [{ title: 'x' }] } })),
    ).toThrow(/missing its id, title, or prompt hash/)
  })

  it('validates every imported metric instead of trusting the TypeScript shape', () => {
    const malformed = toReportFile(report, '2026-09-01T01:00:00.000Z')
    malformed.report.rows[0]!.rounds[0]!.inputTokens = -1

    expect(() => parseReportFile(JSON.stringify(malformed))).toThrow(/input tokens/i)
  })

  it('bounds imported report collections', () => {
    const oversized = toReportFile({ ...report, rows: Array.from({ length: 1_001 }, () => report.rows[0]!) }, '2026-09-01T01:00:00.000Z')

    expect(() => parseReportFile(JSON.stringify(oversized))).toThrow(/too many runs/i)
  })

  it('builds a safe file name from the report name', () => {
    expect(reportFileBase('Opus vs Fable / round 2')).toBe('Opus-vs-Fable-round-2')
    expect(reportFileBase('   ')).toBe('gauntlet-report')
  })
})
