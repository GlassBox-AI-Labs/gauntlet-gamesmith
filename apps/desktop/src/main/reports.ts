import crypto from 'node:crypto'
import type { BuildModels, BuildSnapshot, BuildStatus, PhaseAttempt, AttemptStatus } from '../shared/build'
import { elapsedThroughAttemptMs, runtimeMs } from '../shared/attempt-timing'
import { modelLabel, normalizeModels } from '../shared/models'
import { isIsoTimestamp } from '../shared/persisted-data'
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
  type ReportBuildRow,
} from '../shared/reports'
import { PRICE_TABLE_VERSION } from './pricing'

/** Two builds of the same brief share this, which is the point of showing it. */
export function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(normalizePrompt(prompt), 'utf8').digest('hex')
}

/** Worst news first: a round that is still going, then one that broke, then whatever ended last. */
function roundStatus(attempts: readonly PhaseAttempt[]): AttemptStatus {
  if (attempts.some((attempt) => attempt.status === 'running')) return 'running'
  if (attempts.some((attempt) => attempt.status === 'failed')) return 'failed'
  return attempts.at(-1)?.status ?? 'queued'
}

function sumCacheTokens(attempts: readonly PhaseAttempt[]): { cacheRead: number | null; cacheWrite: number | null } {
  let cacheRead = 0
  let cacheWrite = 0
  let known = false
  for (const attempt of attempts) {
    for (const usage of Object.values(attempt.metrics?.perModel ?? {})) {
      known = true
      cacheRead += usage.tokens.cacheRead
      cacheWrite += usage.tokens.cacheWrite
    }
  }
  return known ? { cacheRead, cacheWrite } : { cacheRead: null, cacheWrite: null }
}

function buildRoundRow(buildCreatedAt: string, round: number, attempts: readonly PhaseAttempt[]): ReportRoundRow {
  const verdictAttempt = [...attempts].reverse().find((attempt) => attempt.verdict)
  const cache = sumCacheTokens(attempts)
  return {
    round,
    attempts: attempts.length,
    status: roundStatus(attempts),
    score: verdictAttempt?.verdict?.score ?? null,
    pass: verdictAttempt?.verdict?.pass ?? false,
    costUsd: attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0),
    inputTokens: attempts.reduce((sum, attempt) => sum + (attempt.inputTokens ?? 0), 0),
    outputTokens: attempts.reduce((sum, attempt) => sum + (attempt.outputTokens ?? 0), 0),
    cacheReadTokens: cache.cacheRead,
    cacheWriteTokens: cache.cacheWrite,
    activeMs: attempts.reduce((sum, attempt) => sum + (runtimeMs(attempt) ?? 0), 0),
    elapsedMs: attempts.reduce<number | null>((latest, attempt) => {
      const elapsed = elapsedThroughAttemptMs(buildCreatedAt, attempt)
      return elapsed == null ? latest : Math.max(latest ?? 0, elapsed)
    }, null),
    revision: attempts.find((attempt) => attempt.role === 'implement' && attempt.revision)?.revision ?? null,
  }
}

/** Freeze one build into a report row, copying in everything a reader needs. */
export function buildReportRow(snapshot: BuildSnapshot): ReportBuildRow {
  const { build } = snapshot
  const attempts = snapshot.attempts.filter((attempt) => attempt.status !== 'queued')
  const byRound = new Map<number, PhaseAttempt[]>()
  for (const attempt of attempts) byRound.set(attempt.round, [...(byRound.get(attempt.round) ?? []), attempt])
  const rounds = [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, roundAttempts]) => buildRoundRow(build.createdAt, round, roundAttempts))

  const scored = rounds.filter((round) => round.score != null)
  const lastFinished = attempts.reduce<string | null>(
    (last, attempt) => (attempt.finishedAt && (!last || attempt.finishedAt > last) ? attempt.finishedAt : last),
    null,
  )
  const cache = sumCacheTokens(attempts)

  return {
    buildId: build.id,
    title: build.title,
    prompt: build.prompt,
    promptHash: hashPrompt(build.prompt),
    workspaceDir: build.workspaceDir,
    models: build.models,
    status: build.status,
    stopReason: build.stopReason,
    roundsUsed: rounds.length,
    maxRounds: build.maxRounds,
    budgetUsd: build.budgetUsd,
    bestScore: scored.length > 0 ? Math.max(...scored.map((round) => round.score!)) : null,
    finalScore: scored.at(-1)?.score ?? null,
    passedAtRound: rounds.find((round) => round.pass)?.round ?? null,
    costUsd: attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0),
    inputTokens: attempts.reduce((sum, attempt) => sum + (attempt.inputTokens ?? 0), 0),
    outputTokens: attempts.reduce((sum, attempt) => sum + (attempt.outputTokens ?? 0), 0),
    cacheReadTokens: cache.cacheRead,
    cacheWriteTokens: cache.cacheWrite,
    wallClockMs: lastFinished ? Math.max(0, new Date(lastFinished).getTime() - new Date(build.createdAt).getTime()) : null,
    activeMs: attempts.reduce((sum, attempt) => sum + (runtimeMs(attempt) ?? 0), 0),
    createdAt: build.createdAt,
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

function describeImplementer(row: ReportBuildRow): string {
  return row.models.subagentModel
    ? `${modelLabel(row.models.subagentModel)} · ${row.models.subagentEffort}`
    : 'solo, no subagents'
}

function outcome(row: ReportBuildRow): string {
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
    `${rows.length} ${rows.length === 1 ? 'build' : 'builds'} · captured ${report.capturedAt} · equivalent cost ${fmtUsd(totals.costUsd)} · ${fmtTokens(totals.inputTokens + totals.outputTokens)} tokens`,
  )
  lines.push('')
  if (rows.length === 0) {
    lines.push('_This report has no builds in it yet._')
    return lines.join('\n')
  }
  if (hasMixedPrompts(rows)) {
    lines.push('> **These builds used different prompts.** The prompt hash column differs, so compare rows one at a time rather than reading the totals as a like-for-like race.')
    lines.push('')
  }

  lines.push('## Setup')
  lines.push('')
  lines.push('| Build | Prompt | Orchestrator | Implementer | Critic | Max rounds | Budget |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const row of rows) {
    lines.push(
      `| ${cell(row.title)} | \`${shortHash(row.promptHash)}\` | ${cell(modelLabel(row.models.orchestratorModel))} · ${row.models.orchestratorEffort} | ${cell(describeImplementer(row))} | ${cell(modelLabel(row.models.criticModel))} · ${row.models.criticEffort} | ${row.maxRounds} | ${fmtUsd(row.budgetUsd)} |`,
    )
  }
  lines.push('')

  lines.push('## Results')
  lines.push('')
  lines.push('| Build | Outcome | Best score | Passed at | Rounds | Cost | Total tokens | In / Out | Wall clock | Active |')
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
    `_Input tokens include cache reads and writes, so total tokens is input plus output. Costs are equivalent API cost estimates (price table ${PRICE_TABLE_VERSION}); builds themselves use subscription logins._`,
  )
  return lines.join('\n')
}

export function toReportFile(report: ReportRecord, exportedAt: string): ReportFile {
  return { kind: REPORT_FILE_KIND, version: REPORT_FILE_VERSION, exportedAt, report }
}

const MAX_REPORT_FILE_BYTES = 8 * 1024 * 1024
const MAX_REPORT_ROWS = 1_000
const MAX_REPORT_ROUNDS = 1_000
const BUILD_STATUSES = new Set<BuildStatus>(['running', 'passed', 'exhausted', 'stopped', 'failed'])
const ATTEMPT_STATUSES = new Set<AttemptStatus>(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'])

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function boundedString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum) {
    throw new Error(`${label} is missing or exceeds its length limit.`)
  }
  return value
}

function timestamp(value: unknown, label: string): string {
  if (!isIsoTimestamp(value)) throw new Error(`${label} is not a canonical timestamp.`)
  return value
}

function counter(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is not a non-negative counter.`)
  return value
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} is not a non-negative finite number.`)
  return value
}

function nullableCounter(value: unknown, label: string): number | null {
  return value === null ? null : counter(value, label)
}

function nullableFinite(value: unknown, label: string, maximum = Number.POSITIVE_INFINITY): number | null {
  if (value === null) return null
  const result = finite(value, label)
  if (result > maximum) throw new Error(`${label} exceeds its allowed range.`)
  return result
}

function nullableString(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : boundedString(value, label, maximum, true)
}

function normalizeReportRound(value: unknown, title: string): ReportRoundRow {
  const round = record(value)
  if (!round) throw new Error(`Build "${title}" has a malformed round.`)
  if (typeof round.status !== 'string' || !ATTEMPT_STATUSES.has(round.status as AttemptStatus)) {
    throw new Error(`Build "${title}" has a round with an invalid status.`)
  }
  if (typeof round.pass !== 'boolean') throw new Error(`Build "${title}" has a round with an invalid pass flag.`)
  return {
    round: counter(round.round, 'Report round number'),
    attempts: counter(round.attempts, 'Report round attempts'),
    status: round.status as AttemptStatus,
    score: nullableFinite(round.score, 'Report round score', 1),
    pass: round.pass,
    costUsd: finite(round.costUsd, 'Report round cost'),
    inputTokens: counter(round.inputTokens, 'Report round input tokens'),
    outputTokens: counter(round.outputTokens, 'Report round output tokens'),
    cacheReadTokens: nullableCounter(round.cacheReadTokens, 'Report round cache-read tokens'),
    cacheWriteTokens: nullableCounter(round.cacheWriteTokens, 'Report round cache-write tokens'),
    activeMs: counter(round.activeMs, 'Report round active time'),
    elapsedMs: nullableCounter(round.elapsedMs, 'Report round elapsed time'),
    revision: nullableString(round.revision, 'Report round revision', 256),
  }
}

function normalizeReportRow(value: unknown): ReportBuildRow {
  const row = record(value)
  // Format 1 called a build a run and carried `loopId`. Accept it as `buildId`;
  // nothing else about the row changed in format 2.
  if (row && typeof row.buildId !== 'string' && typeof row.loopId === 'string') {
    row.buildId = row.loopId
    delete row.loopId
  }
  if (!row || typeof row.buildId !== 'string' || typeof row.title !== 'string' || typeof row.promptHash !== 'string') {
    throw new Error('A build row in that file is missing its id, title, or prompt hash.')
  }
  if (!Array.isArray(row.rounds)) throw new Error(`Build "${row.title}" in that file has no rounds list.`)
  if (row.rounds.length > MAX_REPORT_ROUNDS) throw new Error(`Build "${row.title}" contains too many rounds.`)
  if (!/^[a-f0-9]{64}$/.test(row.promptHash)) throw new Error(`Build "${row.title}" has an invalid prompt hash.`)
  if (typeof row.status !== 'string' || !BUILD_STATUSES.has(row.status as BuildStatus)) throw new Error(`Build "${row.title}" has an invalid status.`)
  if (!record(row.models)) throw new Error(`Build "${row.title}" has no valid model selection.`)
  if (row.finishedAt !== null && !isIsoTimestamp(row.finishedAt)) throw new Error(`Build "${row.title}" has an invalid finish timestamp.`)
  const stopReason = nullableString(row.stopReason, 'Report stop reason', 8_000)
  const title = boundedString(row.title, 'Report build title', 1_000)
  return {
    buildId: boundedString(row.buildId, 'Report build id', 256),
    title,
    prompt: boundedString(row.prompt, 'Report prompt', 100_000, true),
    promptHash: row.promptHash,
    workspaceDir: boundedString(row.workspaceDir, 'Report workspace path', 32_768),
    models: normalizeModels(row.models as Partial<BuildModels>),
    status: row.status as BuildStatus,
    stopReason,
    roundsUsed: counter(row.roundsUsed, 'Report rounds used'),
    maxRounds: counter(row.maxRounds, 'Report maximum rounds'),
    budgetUsd: nullableFinite(row.budgetUsd, 'Report budget'),
    bestScore: nullableFinite(row.bestScore, 'Report best score', 1),
    finalScore: nullableFinite(row.finalScore, 'Report final score', 1),
    passedAtRound: nullableCounter(row.passedAtRound, 'Report passing round'),
    costUsd: finite(row.costUsd, 'Report cost'),
    inputTokens: counter(row.inputTokens, 'Report input tokens'),
    outputTokens: counter(row.outputTokens, 'Report output tokens'),
    cacheReadTokens: nullableCounter(row.cacheReadTokens, 'Report cache-read tokens'),
    cacheWriteTokens: nullableCounter(row.cacheWriteTokens, 'Report cache-write tokens'),
    wallClockMs: nullableCounter(row.wallClockMs, 'Report wall-clock time'),
    activeMs: counter(row.activeMs, 'Report active time'),
    createdAt: timestamp(row.createdAt, 'Report build creation time'),
    finishedAt: row.finishedAt as string | null,
    rounds: row.rounds.map((item) => normalizeReportRound(item, title)),
  }
}

/** Canonical decoder for imported and SQLite-persisted report JSON. */
export function normalizeReportRecord(value: unknown): ReportRecord {
  const report = record(value)
  if (!report || typeof report.name !== 'string' || !Array.isArray(report.rows)) {
    throw new Error('That report file has no name or no builds in it.')
  }
  if (report.rows.length > MAX_REPORT_ROWS) throw new Error('That report contains too many builds.')
  return {
    id: boundedString(report.id, 'Report id', 256),
    name: boundedString(report.name.trim(), 'Report name', 80),
    createdAt: timestamp(report.createdAt, 'Report creation time'),
    updatedAt: timestamp(report.updatedAt, 'Report update time'),
    capturedAt: timestamp(report.capturedAt, 'Report capture time'),
    rows: report.rows.map(normalizeReportRow),
  }
}

/**
 * Read a report someone else exported. The file carries everything, so nothing
 * here is looked up against the local ledger.
 */
export function parseReportFile(text: string): ReportRecord {
  if (Buffer.byteLength(text, 'utf8') > MAX_REPORT_FILE_BYTES) throw new Error('That report exceeds the import size limit.')
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
  if (!Number.isSafeInteger(file.version) || Number(file.version) < 1 || Number(file.version) > REPORT_FILE_VERSION) {
    throw new Error(`That report was written by a newer version of Gauntlet Gamesmith (format ${String(file.version)}).`)
  }
  const report = normalizeReportRecord(file.report)
  if (!isIsoTimestamp(file.exportedAt)) throw new Error('That report has an invalid export timestamp.')
  return report
}

/** A file name that survives every filesystem, derived from the report's own name. */
export function reportFileBase(name: string): string {
  return name.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'gauntlet-report'
}
