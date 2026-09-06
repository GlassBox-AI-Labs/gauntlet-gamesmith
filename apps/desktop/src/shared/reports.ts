import type { BuildModels, BuildStatus, AttemptStatus } from './build'

/** Marker and version written into every exported report file. */
export const REPORT_FILE_KIND = 'gauntlet-gamesmith-report'
/** The marker on reports exported before the app was renamed. Still valid. */
export const LEGACY_REPORT_FILE_KIND = 'gauntlet-loop-report'
export const REPORT_FILE_VERSION = 2
export const REPORT_FILE_SUFFIX = '.gauntlet-report.json'

/**
 * One round of a build, with its attempts folded together. A round is normally
 * one implement attempt plus one critique, but a resumed round can hold more,
 * so `attempts` says how many rows went into these numbers.
 */
export interface ReportRoundRow {
  round: number
  attempts: number
  status: AttemptStatus
  score: number | null
  pass: boolean
  costUsd: number
  /** Everything the model read, cache included — the same figure the build detail shows. */
  inputTokens: number
  outputTokens: number
  /** Only known for builds whose per-model breakdown survived; null on older rows. */
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  /** Time inside this round's own attempts. */
  activeMs: number
  /** Wall clock from the start of the build through the end of this round. */
  elapsedMs: number | null
  revision: string | null
}

/**
 * One build in a report, frozen at capture time. Everything a reader needs is
 * copied in, so an exported report still reads correctly on a machine that has
 * never seen the build itself.
 */
export interface ReportBuildRow {
  buildId: string
  title: string
  prompt: string
  /** SHA-256 of the normalized prompt. Two builds of the same brief share it. */
  promptHash: string
  workspaceDir: string
  models: BuildModels
  status: BuildStatus
  stopReason: string | null
  roundsUsed: number
  maxRounds: number
  budgetUsd: number | null
  bestScore: number | null
  finalScore: number | null
  /** First round the critic passed, or null if it never did. */
  passedAtRound: number | null
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  /** First start to last finish, idle gaps included. */
  wallClockMs: number | null
  /** The attempt durations added up. */
  activeMs: number
  createdAt: string
  finishedAt: string | null
  rounds: ReportRoundRow[]
}

export interface ReportRecord {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  /** When the numbers below were last pulled out of the ledger. */
  capturedAt: string
  rows: ReportBuildRow[]
}

export interface ReportFile {
  kind: typeof REPORT_FILE_KIND
  version: number
  exportedAt: string
  report: ReportRecord
}

export interface ReportTransferResult {
  ok: boolean
  canceled?: boolean
  filePath?: string
  report?: ReportRecord
  error?: string
}

export interface DeleteBuildsResult {
  ok: boolean
  deletedIds: string[]
  /** One line per build that could not be removed, safe to show as-is. */
  errors: string[]
}

export interface ReportTotals {
  attempts: number
  rounds: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  activeMs: number
  wallClockMs: number
}

/** The eight characters shown in the UI. Enough to eyeball, never used to look anything up. */
export function shortHash(hash: string): string {
  return hash.slice(0, 8)
}

/**
 * Strip the resume marker and squash whitespace before hashing, so a resumed
 * attempt and a hand-rewrapped copy of the same brief still match.
 */
export function normalizePrompt(prompt: string): string {
  return prompt.replace(/\[\[gauntlet:resume\]\]/g, '').replace(/\s+/g, ' ').trim()
}

/** True when the report holds builds from more than one brief, so totals mean less. */
export function hasMixedPrompts(rows: readonly ReportBuildRow[]): boolean {
  return new Set(rows.map((row) => row.promptHash)).size > 1
}

export function reportTotals(rows: readonly ReportBuildRow[]): ReportTotals {
  return rows.reduce<ReportTotals>(
    (sum, row) => ({
      attempts: sum.attempts + 1,
      rounds: sum.rounds + row.roundsUsed,
      costUsd: sum.costUsd + row.costUsd,
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      activeMs: sum.activeMs + row.activeMs,
      wallClockMs: sum.wallClockMs + (row.wallClockMs ?? 0),
    }),
    { attempts: 0, rounds: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, activeMs: 0, wallClockMs: 0 },
  )
}

/** Cheapest cost per point of best score — null while nothing has been scored. */
export function costPerPoint(row: ReportBuildRow): number | null {
  return row.bestScore != null && row.bestScore > 0 ? row.costUsd / row.bestScore : null
}

export interface ReportApi {
  list(): Promise<ReportRecord[]>
  get(reportId: string): Promise<ReportRecord | null>
  create(name: string, buildIds: string[]): Promise<ReportRecord | null>
  rename(reportId: string, name: string): Promise<ReportRecord | null>
  addBuilds(reportId: string, buildIds: string[]): Promise<ReportRecord | null>
  removeBuilds(reportId: string, buildIds: string[]): Promise<ReportRecord | null>
  /** Re-read every row whose build is still in the ledger. */
  refresh(reportId: string): Promise<ReportRecord | null>
  remove(reportId: string): Promise<boolean>
  markdown(reportId: string): Promise<string>
  exportJson(reportId: string): Promise<ReportTransferResult>
  exportMarkdown(reportId: string): Promise<ReportTransferResult>
  importReport(): Promise<ReportTransferResult>
}
