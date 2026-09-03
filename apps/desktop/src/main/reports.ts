import crypto from 'node:crypto'
import type { LoopSnapshot, RunRecord, RunStatus } from '../shared/loop'
import { elapsedThroughRunMs, runtimeMs } from '../shared/run-timing'
import { modelLabel } from '../shared/models'
import {
  hasMixedPrompts,
  LEGACY_REPORT_FILE_KIND,
  normalizePrompt,
  REPORT_FILE_KIND,
  REPORT_FILE_VERSION,
  reportTotals,
  shortHash,
  type ReportFile,
  type ReportRecord,
  type ReportRoundRow,
  type ReportRunRow,
} from '../shared/reports'
import { PRICE_TABLE_VERSION } from './pricing'

/** Two runs of the same brief share this, which is the point of showing it. */
export function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(normalizePrompt(prompt), 'utf8').digest('hex')
}

/** Worst news first: a round that is still going, then one that broke, then whatever ended last. */
function roundStatus(runs: readonly RunRecord[]): RunStatus {
  if (runs.some((run) => run.status === 'running')) return 'running'
  if (runs.some((run) => run.status === 'failed')) return 'failed'
  return runs.at(-1)?.status ?? 'queued'
}

function sumCacheTokens(runs: readonly RunRecord[]): { cacheRead: number | null; cacheWrite: number | null } {
  let cacheRead = 0
  let cacheWrite = 0
  let known = false
  for (const run of runs) {
    for (const usage of Object.values(run.metrics?.perModel ?? {})) {
      known = true
      cacheRead += usage.tokens.cacheRead
      cacheWrite += usage.tokens.cacheWrite
    }
  }
  return known ? { cacheRead, cacheWrite } : { cacheRead: null, cacheWrite: null }
}

function buildRoundRow(loopCreatedAt: string, round: number, runs: readonly RunRecord[]): ReportRoundRow {
  const verdictRun = [...runs].reverse().find((run) => run.verdict)
  const cache = sumCacheTokens(runs)
  return {
    round,
    attempts: runs.length,
    status: roundStatus(runs),
    score: verdictRun?.verdict?.score ?? null,
    pass: verdictRun?.verdict?.pass ?? false,
    costUsd: runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
    inputTokens: runs.reduce((sum, run) => sum + (run.inputTokens ?? 0), 0),
    outputTokens: runs.reduce((sum, run) => sum + (run.outputTokens ?? 0), 0),
    cacheReadTokens: cache.cacheRead,
    cacheWriteTokens: cache.cacheWrite,
    activeMs: runs.reduce((sum, run) => sum + (runtimeMs(run) ?? 0), 0),
    elapsedMs: runs.reduce<number | null>((latest, run) => {
      const elapsed = elapsedThroughRunMs(loopCreatedAt, run)
      return elapsed == null ? latest : Math.max(latest ?? 0, elapsed)
    }, null),
    revision: runs.find((run) => run.role === 'implement' && run.revision)?.revision ?? null,
  }
}

/** Freeze one run into a report row, copying in everything a reader needs. */
export function buildReportRow(snapshot: LoopSnapshot): ReportRunRow {
  const { loop } = snapshot
  const runs = snapshot.runs.filter((run) => run.status !== 'queued')
  const byRound = new Map<number, RunRecord[]>()
  for (const run of runs) byRound.set(run.round, [...(byRound.get(run.round) ?? []), run])
  const rounds = [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, roundRuns]) => buildRoundRow(loop.createdAt, round, roundRuns))

  const scored = rounds.filter((round) => round.score != null)
  const lastFinished = runs.reduce<string | null>(
    (last, run) => (run.finishedAt && (!last || run.finishedAt > last) ? run.finishedAt : last),
    null,
  )
  const cache = sumCacheTokens(runs)

  return {
    loopId: loop.id,
    title: loop.title,
    prompt: loop.prompt,
    promptHash: hashPrompt(loop.prompt),
    workspaceDir: loop.workspaceDir,
    models: loop.models,
    status: loop.status,
    stopReason: loop.stopReason,
    roundsUsed: rounds.length,
    maxRounds: loop.maxRounds,
    budgetUsd: loop.budgetUsd,
    bestScore: scored.length > 0 ? Math.max(...scored.map((round) => round.score!)) : null,
    finalScore: scored.at(-1)?.score ?? null,
    passedAtRound: rounds.find((round) => round.pass)?.round ?? null,
    costUsd: runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
    inputTokens: runs.reduce((sum, run) => sum + (run.inputTokens ?? 0), 0),
    outputTokens: runs.reduce((sum, run) => sum + (run.outputTokens ?? 0), 0),
    cacheReadTokens: cache.cacheRead,
    cacheWriteTokens: cache.cacheWrite,
    wallClockMs: lastFinished ? Math.max(0, new Date(lastFinished).getTime() - new Date(loop.createdAt).getTime()) : null,
    activeMs: runs.reduce((sum, run) => sum + (runtimeMs(run) ?? 0), 0),
    createdAt: loop.createdAt,
    finishedAt: lastFinished,
    rounds,
  }
}

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor(totalSec / 60) % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(totalSec % 60).padStart(2, '0')}s`
}

function fmtUsd(value: number | null | undefined): string {
  return value == null ? '—' : `$${value.toFixed(2)}`
}

function describeImplementer(row: ReportRunRow): string {
  return row.models.subagentModel
    ? `${modelLabel(row.models.subagentModel)} · ${row.models.subagentEffort}`
    : 'solo, no subagents'
}

function outcome(row: ReportRunRow): string {
  return row.stopReason ? `${row.status} — ${row.stopReason}` : row.status
}

/** Pipes inside a cell would split the column, so they are escaped rather than dropped. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
}

/** The shareable version of a report: the same numbers, readable without the app. */
export function renderReportMarkdown(report: ReportRecord): string {
  const rows = report.rows
  const totals = reportTotals(rows)
  const lines: string[] = []

  lines.push(`# ${report.name}`)
  lines.push('')
  lines.push(
    `${rows.length} ${rows.length === 1 ? 'run' : 'runs'} · captured ${report.capturedAt} · equivalent cost ${fmtUsd(totals.costUsd)} · ${fmtTokens(totals.inputTokens + totals.outputTokens)} tokens`,
  )
  lines.push('')
  if (rows.length === 0) {
    lines.push('_This report has no runs in it yet._')
    return lines.join('\n')
  }
  if (hasMixedPrompts(rows)) {
    lines.push('> **These runs used different prompts.** The prompt hash column differs, so compare rows one at a time rather than reading the totals as a like-for-like race.')
    lines.push('')
  }

  lines.push('## Setup')
  lines.push('')
  lines.push('| Run | Prompt | Orchestrator | Implementer | Critic | Max rounds | Budget |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const row of rows) {
    lines.push(
      `| ${cell(row.title)} | \`${shortHash(row.promptHash)}\` | ${cell(modelLabel(row.models.orchestratorModel))} · ${row.models.orchestratorEffort} | ${cell(describeImplementer(row))} | ${cell(modelLabel(row.models.criticModel))} · ${row.models.criticEffort} | ${row.maxRounds} | ${fmtUsd(row.budgetUsd)} |`,
    )
  }
  lines.push('')

  lines.push('## Results')
  lines.push('')
  lines.push('| Run | Outcome | Best score | Passed at | Rounds | Cost | Total tokens | In / Out | Wall clock | Active |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const row of rows) {
    lines.push(
      `| ${cell(row.title)} | ${cell(outcome(row))} | ${row.bestScore?.toFixed(2) ?? '—'} | ${row.passedAtRound ?? '—'} | ${row.roundsUsed} of ${row.maxRounds} | ${fmtUsd(row.costUsd)} | ${fmtTokens(row.inputTokens + row.outputTokens)} | ${fmtTokens(row.inputTokens)} / ${fmtTokens(row.outputTokens)} | ${fmtDuration(row.wallClockMs)} | ${fmtDuration(row.activeMs)} |`,
    )
  }
  lines.push(
    `| **Total** | | | | ${totals.rounds} | **${fmtUsd(totals.costUsd)}** | **${fmtTokens(totals.inputTokens + totals.outputTokens)}** | ${fmtTokens(totals.inputTokens)} / ${fmtTokens(totals.outputTokens)} | ${fmtDuration(totals.wallClockMs)} | ${fmtDuration(totals.activeMs)} |`,
  )
  lines.push('')

  for (const row of rows) {
    lines.push(`## ${row.title}`)
    lines.push('')
    lines.push(`- **Prompt hash:** \`${shortHash(row.promptHash)}\` (SHA-256 of the prompt with whitespace squashed)`)
    lines.push(`- **Prompt:** ${cell(row.prompt.slice(0, 400))}${row.prompt.length > 400 ? '…' : ''}`)
    lines.push(`- **Workspace:** ${row.workspaceDir}`)
    lines.push(`- **Started:** ${row.createdAt}${row.finishedAt ? ` · **Last finished:** ${row.finishedAt}` : ''}`)
    if (row.cacheReadTokens != null) {
      lines.push(`- **Cache tokens:** read ${fmtTokens(row.cacheReadTokens)} · written ${fmtTokens(row.cacheWriteTokens)} (already counted inside the input column)`)
    }
    lines.push('')
    if (row.rounds.length > 0) {
      lines.push('| Round | Attempts | Status | Score | Cost | In / Out | Active | Elapsed | Revision |')
      lines.push('|---|---|---|---|---|---|---|---|---|')
      for (const round of row.rounds) {
        lines.push(
          `| ${round.round} | ${round.attempts} | ${round.status} | ${round.score?.toFixed(2) ?? '—'}${round.pass ? ' ✓' : ''} | ${fmtUsd(round.costUsd)} | ${fmtTokens(round.inputTokens)} / ${fmtTokens(round.outputTokens)} | ${fmtDuration(round.activeMs)} | ${round.elapsedMs == null ? '—' : `+${fmtDuration(round.elapsedMs)}`} | ${round.revision?.slice(0, 12) ?? '—'} |`,
        )
      }
      lines.push('')
    }
  }

  lines.push(
    `_Input tokens include cache reads and writes, so total tokens is input plus output. Costs are equivalent API cost estimates (price table ${PRICE_TABLE_VERSION}); runs themselves use subscription logins._`,
  )
  return lines.join('\n')
}

export function toReportFile(report: ReportRecord, exportedAt: string): ReportFile {
  return { kind: REPORT_FILE_KIND, version: REPORT_FILE_VERSION, exportedAt, report }
}

function asRow(value: unknown): ReportRunRow {
  const row = value as Partial<ReportRunRow>
  if (typeof row?.loopId !== 'string' || typeof row.title !== 'string' || typeof row.promptHash !== 'string') {
    throw new Error('A run row in that file is missing its id, title, or prompt hash.')
  }
  if (!Array.isArray(row.rounds)) throw new Error(`Run "${row.title}" in that file has no rounds list.`)
  return row as ReportRunRow
}

/**
 * Read a report someone else exported. The file carries everything, so nothing
 * here is looked up against the local ledger.
 */
export function parseReportFile(text: string): ReportRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  const file = parsed as Partial<ReportFile>
  if (file?.kind !== REPORT_FILE_KIND && file?.kind !== LEGACY_REPORT_FILE_KIND) {
    throw new Error('That file is not a Gauntlet Gamesmith report.')
  }
  if (typeof file.version !== 'number' || file.version > REPORT_FILE_VERSION) {
    throw new Error(`That report was written by a newer version of Gauntlet Gamesmith (format ${String(file.version)}).`)
  }
  const report = file.report as Partial<ReportRecord> | undefined
  if (!report || typeof report.name !== 'string' || !Array.isArray(report.rows)) {
    throw new Error('That report file has no name or no runs in it.')
  }
  return {
    id: typeof report.id === 'string' ? report.id : '',
    name: report.name,
    createdAt: typeof report.createdAt === 'string' ? report.createdAt : new Date().toISOString(),
    updatedAt: typeof report.updatedAt === 'string' ? report.updatedAt : new Date().toISOString(),
    capturedAt: typeof report.capturedAt === 'string' ? report.capturedAt : new Date().toISOString(),
    rows: report.rows.map(asRow),
  }
}

/** A file name that survives every filesystem, derived from the report's own name. */
export function reportFileBase(name: string): string {
  return name.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'gauntlet-report'
}
