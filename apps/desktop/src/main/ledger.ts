import { captureExistingBuildTrust } from './existing-build-trust'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  LogChannel,
  BuildLogLine,
  BuildModels,
  BuildRecord,
  BuildSnapshot,
  BuildStatus,
  AttemptMetrics,
  PhaseAttempt,
  PhaseRole,
  AttemptStatus,
  Verdict,
} from '../shared/build'
import type { ReportRecord } from '../shared/reports'
import { normalizeModels } from '../shared/models'
import { channelForKind, markResumePrompt } from '../shared/build'
import { isIsoTimestamp, normalizePersistedModel, normalizeAttemptMetrics, normalizeVerdict } from '../shared/persisted-data'
import { isRecordId } from '../shared/record-id'
import { redactLogText } from '../shared/redact-log'
import { normalizeSessionId } from '../shared/session-id'
import { canonicalizePath, migrateBuildMetadataDir, restoreBuildLedgerSnapshot, buildLedgerPath, snapshotBuildLedger, type BuildLedgerSourceIdentity } from './build-transfer'
import { assertSafeWorkspaceFile, safeWorkspaceMetadataDir } from './workspace-metadata'
import { assertBuildWorkspaceIdentity, assertWorkspaceBoundary, captureWorkspaceIdentity } from './workspace-boundary'
import type { PromptLogAttempt } from './prompt-logs'
import { normalizeReportRecord } from './reports'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  title TEXT,
  prompt TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  workspace_dev INTEGER,
  workspace_ino INTEGER,
  max_rounds INTEGER NOT NULL,
  budget_usd REAL,
  models_json TEXT NOT NULL,
  status TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  stop_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  play_trusted INTEGER NOT NULL DEFAULT 0,
  execution_trusted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS phase_attempts (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL REFERENCES builds(id),
  round INTEGER NOT NULL,
  role TEXT NOT NULL,
  harness TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  cli_version TEXT,
  price_table_version TEXT,
  cost_source TEXT,
  prompt_sha256 TEXT,
  account_label TEXT,
  machine_label TEXT,
  auth_mode TEXT,
  process_ownership_json TEXT,
  summary TEXT,
  verdict_json TEXT,
  metrics_json TEXT,
  cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  num_turns INTEGER,
  duration_ms INTEGER,
  session_id TEXT,
  revision TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id TEXT NOT NULL,
  attempt_id TEXT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  agent_id TEXT,
  round INTEGER,
  role TEXT,
  channel TEXT
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_build ON phase_attempts(build_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_build ON events(build_id, seq);
`

function now(): string {
  return new Date().toISOString()
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const MAX_JSON_BYTES = 8 * 1024 * 1024

function parseStoredJson(text: string, label: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new Error(`${label} exceeds the persisted JSON safety limit.`)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${label} is not valid JSON.`)
  }
}

interface BuildRow {
  id: string
  title: string | null
  prompt: string
  workspace_dir: string
  workspace_dev: number | null
  workspace_ino: number | null
  max_rounds: number
  budget_usd: number | null
  models_json: string
  status: string
  round: number
  total_cost_usd: number
  stop_reason: string | null
  created_at: string
  updated_at: string
  play_trusted: number
  execution_trusted: number
}

const BUILD_LIST_PROJECTION_COLUMNS = `
  id, substr(title, 1, 1000) AS title, substr(prompt, 1, 1024) AS prompt,
  substr(workspace_dir, 1, 32768) AS workspace_dir, workspace_dev, workspace_ino,
  max_rounds, budget_usd,
  CASE WHEN length(models_json) <= 4096 THEN models_json ELSE '{}' END AS models_json,
  status, round, total_cost_usd, substr(stop_reason, 1, 4096) AS stop_reason,
  created_at, updated_at, play_trusted, execution_trusted`

interface AttemptRow {
  id: string
  build_id: string
  round: number
  role: string
  harness: string
  status: string
  prompt: string
  model: string | null
  effort: string | null
  cli_version: string | null
  price_table_version: string | null
  cost_source: string | null
  prompt_sha256: string | null
  account_label: string | null
  machine_label: string | null
  auth_mode: string | null
  process_ownership_json: string | null
  summary: string | null
  verdict_json: string | null
  metrics_json: string | null
  cost_usd: number | null
  input_tokens: number | null
  output_tokens: number | null
  num_turns: number | null
  duration_ms: number | null
  session_id: string | null
  revision: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

interface AttemptProjectionRow extends AttemptRow {
  _projection_truncated: number
}

const ATTEMPT_PROJECTION_COLUMNS = `
  id, build_id, round, role, harness, status,
  substr(prompt, 1, 65536) AS prompt,
  model, effort, cli_version, price_table_version, cost_source, prompt_sha256,
  account_label, machine_label, auth_mode,
  substr(summary, 1, 16384) AS summary,
  CASE WHEN length(verdict_json) <= 262144 THEN verdict_json ELSE NULL END AS verdict_json,
  CASE WHEN length(metrics_json) <= 524288 THEN metrics_json ELSE NULL END AS metrics_json,
  cost_usd, input_tokens, output_tokens, num_turns, duration_ms, session_id, revision,
  substr(error, 1, 16384) AS error,
  created_at, started_at, finished_at,
  CASE WHEN length(prompt) > 65536 OR length(summary) > 16384 OR length(verdict_json) > 262144
    OR length(metrics_json) > 524288 OR length(error) > 16384 THEN 1 ELSE 0 END AS _projection_truncated`

interface EventRow {
  seq: number
  build_id: string
  attempt_id: string | null
  ts: string
  kind: string
  text: string
  agent_id: string | null
  round: number | null
  role: string | null
  channel: string | null
}

interface EventProjectionRow extends EventRow {
  _projection_truncated: number
}

const EVENT_PROJECTION_COLUMNS = `
  seq, build_id, attempt_id, ts, kind,
  CASE WHEN length(text) > 4096 THEN substr(text, 1, 4060) || '… [projection truncated]' ELSE text END AS text,
  agent_id, round, role, channel,
  CASE WHEN length(text) > 4096 THEN 1 ELSE 0 END AS _projection_truncated`

const BUILD_STATUSES = new Set<BuildStatus>(['running', 'passed', 'exhausted', 'stopped', 'failed'])
const ATTEMPT_STATUSES = new Set<AttemptStatus>(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'])
const PHASE_ROLES = new Set<PhaseRole>(['reference', 'implement', 'critique', 'consult'])
const LOG_CHANNELS = new Set<LogChannel>(['prompt', 'thought', 'tool', 'output', 'search', 'media', 'usage', 'error', 'system'])
const REVISION = /^[0-9a-f]{40,64}$/
const SHA256 = /^[0-9a-f]{64}$/
const AUTH_MODES = new Set(['subscription', 'api_key'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'])
const PRICE_TABLE_VERSION = /^\d{4}-\d{2}-\d{2}$/
const MAX_IMPORT_BUILDS = 1_000
const MAX_IMPORT_ATTEMPTS = 25_000
const MAX_IMPORT_EVENTS = 100_000
const MAX_ATTEMPT_COST_USD = 1_000_000
const MAX_ATTEMPT_TOKENS = 1_000_000_000
const MAX_ATTEMPT_TURNS = 1_000_000
const MAX_ATTEMPT_DURATION_MS = 366 * 24 * 60 * 60_000
export const MAX_OPEN_FOLDER_DATABASES = 8
export const MAX_MATERIALIZED_ATTEMPT_HISTORY = 1_000
const MAX_MATERIALIZED_BUILD_HISTORY = 1_000
const MAX_RUNNING_BUILD_RECOVERY = 1_000
const MAX_RETAINED_MIRROR_RECOVERY_FILES = 64
const MAX_RETAINED_MIRROR_RECOVERY_BYTES = 2 * 1024 * 1024 * 1024
const MIRROR_RECOVERY_NAME = /^\.ledger\.[0-9a-f-]{36}\.ledger\.db(?:-(?:journal|wal|shm))?\.recovery$/

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function stringField(row: Record<string, unknown>, key: string, max: number, nullable = false): string | null {
  const value = row[key]
  if (nullable && (value === null || value === undefined)) return null
  if (typeof value !== 'string' || value.length > max) throw new Error(`${key} must be a bounded string.`)
  return value
}

function numberField(row: Record<string, unknown>, key: string, options: { nullable?: boolean; integer?: boolean; min?: number; max?: number } = {}): number | null {
  const value = row[key]
  if (options.nullable && (value === null || value === undefined)) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || (options.integer && !Number.isSafeInteger(value)) || value < (options.min ?? -Infinity) || value > (options.max ?? Infinity)) {
    throw new Error(`${key} must be a valid number.`)
  }
  return value
}

function timestampField(row: Record<string, unknown>, key: string, nullable = false): string | null {
  const value = stringField(row, key, 128, nullable)
  if (value === null) return null
  if (!isIsoTimestamp(value)) throw new Error(`${key} must be a canonical ISO timestamp.`)
  return value
}

function provenanceField(row: Record<string, unknown>, key: string, max: number): string | null {
  const value = stringField(row, key, max, true)
  if (value === null) return null
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${key} must be a bounded single-line string.`)
  return redactLogText(value)
}

function patchProvenance(value: string | null, label: string, max: number): string | null {
  if (value === null) return null
  if (value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded single-line string.`)
  }
  return redactLogText(value)
}

function projectedProvenance(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return null
  return redactLogText(value)
}

function normalizeBuildRow(value: unknown): BuildRow {
  const row = record(value, 'Build row')
  const id = stringField(row, 'id', 128)!
  if (!isRecordId(id)) throw new Error('Build id has an invalid format.')
  const status = stringField(row, 'status', 32)!
  if (!BUILD_STATUSES.has(status as BuildStatus)) throw new Error(`Build ${id} has an invalid status.`)
  const playTrusted = row.play_trusted === undefined ? 0 : numberField(row, 'play_trusted', { integer: true, min: 0 })!
  if (playTrusted !== 0 && playTrusted !== 1) throw new Error(`Build ${id} has an invalid Play trust flag.`)
  const normalized: BuildRow = {
    id,
    title: row.title == null ? null : redactLogText(stringField(row, 'title', 1_000)!),
    prompt: redactLogText(stringField(row, 'prompt', 2 * 1024 * 1024)!),
    workspace_dir: stringField(row, 'workspace_dir', 32_768)!,
    workspace_dev: numberField(row, 'workspace_dev', { nullable: true, integer: true, min: 1 }),
    workspace_ino: numberField(row, 'workspace_ino', { nullable: true, integer: true, min: 1 }),
    max_rounds: numberField(row, 'max_rounds', { integer: true, min: 1 })!,
    budget_usd: numberField(row, 'budget_usd', { nullable: true, min: 0 }),
    models_json: stringField(row, 'models_json', MAX_JSON_BYTES)!,
    status: status as BuildStatus,
    round: numberField(row, 'round', { integer: true, min: 0 })!,
    total_cost_usd: numberField(row, 'total_cost_usd', { min: 0 })!,
    stop_reason: row.stop_reason == null ? null : redactLogText(stringField(row, 'stop_reason', 16_384)!),
    created_at: timestampField(row, 'created_at')!,
    updated_at: timestampField(row, 'updated_at')!,
    play_trusted: playTrusted,
    execution_trusted: 0, // Portable consent is never authority on this machine.
  }
  // Validate and normalize historical model JSON without replacing old names.
  normalized.models_json = JSON.stringify(toBuild(normalized).models)
  return normalized
}

function normalizeAttemptRow(value: unknown): AttemptRow {
  const row = record(value, 'Build row')
  const id = stringField(row, 'id', 128)!
  const buildId = stringField(row, 'build_id', 128)!
  if (!isRecordId(id) || !isRecordId(buildId)) throw new Error('Build id has an invalid format.')
  const role = stringField(row, 'role', 32)!
  const harness = stringField(row, 'harness', 32)!
  const status = stringField(row, 'status', 32)!
  if (!PHASE_ROLES.has(role as PhaseRole)) throw new Error(`Attempt ${id} has an invalid role.`)
  if (harness !== 'claude' && harness !== 'codex') throw new Error(`Attempt ${id} has an invalid harness.`)
  if (!ATTEMPT_STATUSES.has(status as AttemptStatus)) throw new Error(`Attempt ${id} has an invalid status.`)
  const revision = stringField(row, 'revision', 64, true)
  if (revision && !REVISION.test(revision)) throw new Error(`Attempt ${id} has an invalid revision.`)
  const promptSha256 = stringField(row, 'prompt_sha256', 64, true)
  if (promptSha256 && !SHA256.test(promptSha256)) throw new Error(`Attempt ${id} has an invalid prompt hash.`)
  const authMode = stringField(row, 'auth_mode', 32, true)
  if (authMode && !AUTH_MODES.has(authMode)) throw new Error(`Attempt ${id} has an invalid authentication mode.`)
  const rawModel = stringField(row, 'model', 256, true)
  const model = rawModel === null ? null : normalizePersistedModel(rawModel)
  if (rawModel !== null && model === null) throw new Error(`Attempt ${id} has an invalid model identifier.`)
  const effort = stringField(row, 'effort', 32, true)
  if (effort !== null && !EFFORTS.has(effort)) throw new Error(`Attempt ${id} has an invalid effort.`)
  const priceTableVersion = provenanceField(row, 'price_table_version', 256)
  if (priceTableVersion !== null && !PRICE_TABLE_VERSION.test(priceTableVersion)) {
    throw new Error(`Attempt ${id} has an invalid price-table version.`)
  }
  const sessionId = stringField(row, 'session_id', 128, true)
  if (sessionId !== null && normalizeSessionId(sessionId) === null) throw new Error(`Attempt ${id} has an invalid session id.`)
  const verdictJson = stringField(row, 'verdict_json', MAX_JSON_BYTES, true)
  const verdict = verdictJson === null ? null : normalizeVerdict(parseStoredJson(verdictJson, `Attempt ${id} verdict`))
  if (verdictJson !== null && verdict === null) throw new Error(`Attempt ${id} verdict does not match the stored verdict contract.`)
  const metricsJson = stringField(row, 'metrics_json', MAX_JSON_BYTES, true)
  const metrics = metricsJson === null ? null : normalizeAttemptMetrics(parseStoredJson(metricsJson, `Attempt ${id} metrics`))
  if (metricsJson !== null && metrics === null) throw new Error(`Attempt ${id} metrics do not match the stored metrics contract.`)
  stringField(row, 'process_ownership_json', 8 * 1024, true)
  const normalized: AttemptRow = {
    id,
    build_id: buildId,
    round: numberField(row, 'round', { integer: true, min: 0 })!,
    role,
    harness,
    status,
    prompt: redactLogText(stringField(row, 'prompt', 2 * 1024 * 1024)!),
    model,
    effort,
    cli_version: provenanceField(row, 'cli_version', 1_000),
    price_table_version: priceTableVersion,
    cost_source: provenanceField(row, 'cost_source', 256),
    prompt_sha256: promptSha256,
    account_label: provenanceField(row, 'account_label', 256),
    machine_label: provenanceField(row, 'machine_label', 256),
    auth_mode: authMode,
    // A transferred workspace is not authoritative for live process
    // ownership. Import always clears it before the row can be recovered.
    process_ownership_json: null,
    summary: row.summary == null ? null : redactLogText(stringField(row, 'summary', 64 * 1024)!),
    verdict_json: verdict === null ? null : JSON.stringify(verdict),
    metrics_json: metrics === null ? null : JSON.stringify(metrics),
    cost_usd: numberField(row, 'cost_usd', { nullable: true, min: 0, max: MAX_ATTEMPT_COST_USD }),
    input_tokens: numberField(row, 'input_tokens', { nullable: true, integer: true, min: 0, max: MAX_ATTEMPT_TOKENS }),
    output_tokens: numberField(row, 'output_tokens', { nullable: true, integer: true, min: 0, max: MAX_ATTEMPT_TOKENS }),
    num_turns: numberField(row, 'num_turns', { nullable: true, integer: true, min: 0, max: MAX_ATTEMPT_TURNS }),
    duration_ms: numberField(row, 'duration_ms', { nullable: true, integer: true, min: 0, max: MAX_ATTEMPT_DURATION_MS }),
    session_id: sessionId,
    revision,
    error: row.error == null ? null : redactLogText(stringField(row, 'error', 64 * 1024)!),
    created_at: timestampField(row, 'created_at')!,
    started_at: timestampField(row, 'started_at', true),
    finished_at: timestampField(row, 'finished_at', true),
  }
  toAttempt(normalized)
  return normalized
}

function normalizeEventRow(value: unknown): EventRow {
  const row = record(value, 'Event row')
  const buildId = stringField(row, 'build_id', 128)!
  const attemptId = stringField(row, 'attempt_id', 128, true)
  if (!isRecordId(buildId) || (attemptId && !isRecordId(attemptId))) throw new Error('Event id has an invalid format.')
  const role = stringField(row, 'role', 32, true)
  const channel = stringField(row, 'channel', 32, true)
  if (role && !PHASE_ROLES.has(role as PhaseRole)) throw new Error('Event has an invalid role.')
  if (channel && !LOG_CHANNELS.has(channel as LogChannel)) throw new Error('Event has an invalid channel.')
  return {
    seq: numberField(row, 'seq', { integer: true, min: 1 })!,
    build_id: buildId,
    attempt_id: attemptId,
    ts: timestampField(row, 'ts')!,
    kind: stringField(row, 'kind', 64)!,
    text: redactLogText(stringField(row, 'text', 64 * 1024)!),
    agent_id: row.agent_id == null ? null : redactLogText(stringField(row, 'agent_id', 256)!),
    round: numberField(row, 'round', { nullable: true, integer: true, min: 0 }),
    role,
    channel,
  }
}

/**
 * Rename the pre-Build vocabulary in place: `loops` → `builds`, `runs` →
 * `phase_attempts`, and their foreign-key columns. Guarded on the old table
 * still existing, so running it twice is a no-op (DATA-002). This must happen
 * before `SCHEMA` executes, or the fresh empty tables would hide the old ones.
 *
 * Both ledgers reach this through `initializeSchema`, so the app registry and
 * every project-folder mirror migrate at their existing open points.
 */
function migrateLegacyNames(db: DatabaseSync, backupPath: string | null): void {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as unknown as { name: string }[])
      .map((table) => table.name),
  )
  if (!tables.has('loops') || tables.has('builds')) return

  // The only irreversible step in the rename. VACUUM INTO writes a consistent
  // copy through SQLite itself, so it is safe in WAL mode and cannot capture a
  // torn page the way a file copy could. It refuses an existing target.
  if (backupPath) {
    let target = backupPath
    if (fs.existsSync(target)) target = `${backupPath}.${Date.now()}`
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('ALTER TABLE loops RENAME TO builds')
    db.exec('ALTER TABLE runs RENAME TO phase_attempts')
    db.exec('ALTER TABLE phase_attempts RENAME COLUMN loop_id TO build_id')
    db.exec('ALTER TABLE events RENAME COLUMN loop_id TO build_id')
    db.exec('ALTER TABLE events RENAME COLUMN run_id TO attempt_id')
    // A renamed table keeps its old index names; SCHEMA recreates them.
    db.exec('DROP INDEX IF EXISTS idx_runs_loop')
    db.exec('DROP INDEX IF EXISTS idx_events_loop')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function initializeSchema(db: DatabaseSync, journalMode: 'WAL' | 'DELETE', backupPath: string | null = null): void {
  db.exec(`PRAGMA journal_mode = ${journalMode};`)
  migrateLegacyNames(db, backupPath)
  db.exec(SCHEMA)
  const additions = {
    builds: [
      ['title', 'ALTER TABLE builds ADD COLUMN title TEXT'],
      ['execution_trusted', 'ALTER TABLE builds ADD COLUMN execution_trusted INTEGER NOT NULL DEFAULT 0'],
      ['play_trusted', 'ALTER TABLE builds ADD COLUMN play_trusted INTEGER NOT NULL DEFAULT 0'],
      ['workspace_dev', 'ALTER TABLE builds ADD COLUMN workspace_dev INTEGER'],
      ['workspace_ino', 'ALTER TABLE builds ADD COLUMN workspace_ino INTEGER'],
    ],
    phase_attempts: [
      ['revision', 'ALTER TABLE phase_attempts ADD COLUMN revision TEXT'],
      ['effort', 'ALTER TABLE phase_attempts ADD COLUMN effort TEXT'],
      ['cli_version', 'ALTER TABLE phase_attempts ADD COLUMN cli_version TEXT'],
      ['price_table_version', 'ALTER TABLE phase_attempts ADD COLUMN price_table_version TEXT'],
      ['cost_source', 'ALTER TABLE phase_attempts ADD COLUMN cost_source TEXT'],
      ['prompt_sha256', 'ALTER TABLE phase_attempts ADD COLUMN prompt_sha256 TEXT'],
      ['account_label', 'ALTER TABLE phase_attempts ADD COLUMN account_label TEXT'],
      ['machine_label', 'ALTER TABLE phase_attempts ADD COLUMN machine_label TEXT'],
      ['auth_mode', 'ALTER TABLE phase_attempts ADD COLUMN auth_mode TEXT'],
      ['process_ownership_json', 'ALTER TABLE phase_attempts ADD COLUMN process_ownership_json TEXT'],
    ],
    events: [
      ['agent_id', 'ALTER TABLE events ADD COLUMN agent_id TEXT'],
      ['round', 'ALTER TABLE events ADD COLUMN round INTEGER'],
      ['role', 'ALTER TABLE events ADD COLUMN role TEXT'],
      ['channel', 'ALTER TABLE events ADD COLUMN channel TEXT'],
    ],
  } as const
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [table, columns] of Object.entries(additions)) {
      const existing = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((column) => column.name),
      )
      for (const [name, sql] of columns) if (!existing.has(name)) db.exec(sql)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

interface ImportedRows {
  builds: BuildRow[]
  attemptsByBuild: Map<string, AttemptRow[]>
  eventsByBuild: Map<string, EventRow[]>
}

/**
 * A project folder written before the Build rename still names its tables
 * `loops`/`runs`. Import validates whichever shape it finds, then migrates its
 * own private snapshot copy, so everything downstream speaks current names.
 */
interface LedgerShape {
  builds: string
  attempts: string
  buildId: string
  attemptId: string
  attemptsIndex: string
  eventsIndex: string
}

const CURRENT_SHAPE: LedgerShape = {
  builds: 'builds',
  attempts: 'phase_attempts',
  buildId: 'build_id',
  attemptId: 'attempt_id',
  attemptsIndex: 'idx_attempts_build',
  eventsIndex: 'idx_events_build',
}

const LEGACY_SHAPE: LedgerShape = {
  builds: 'loops',
  attempts: 'runs',
  buildId: 'loop_id',
  attemptId: 'run_id',
  attemptsIndex: 'idx_runs_loop',
  eventsIndex: 'idx_events_loop',
}

/** Rewrite a current-shape column list into the names the given shape uses. */
function shapedColumns(names: readonly string[], shape: LedgerShape): string[] {
  return names.map((name) => (name === 'build_id' ? shape.buildId : name === 'attempt_id' ? shape.attemptId : name))
}

const IMPORT_COLUMNS = {
  builds: {
    required: ['id', 'prompt', 'workspace_dir', 'max_rounds', 'budget_usd', 'models_json', 'status', 'round', 'total_cost_usd', 'stop_reason', 'created_at', 'updated_at'],
    allowed: ['id', 'title', 'prompt', 'workspace_dir', 'workspace_dev', 'workspace_ino', 'max_rounds', 'budget_usd', 'models_json', 'status', 'round', 'total_cost_usd', 'stop_reason', 'created_at', 'updated_at', 'play_trusted', 'execution_trusted'],
  },
  phase_attempts: {
    required: ['id', 'build_id', 'round', 'role', 'harness', 'status', 'prompt', 'model', 'summary', 'verdict_json', 'metrics_json', 'cost_usd', 'input_tokens', 'output_tokens', 'num_turns', 'duration_ms', 'session_id', 'error', 'created_at', 'started_at', 'finished_at'],
    allowed: ['id', 'build_id', 'round', 'role', 'harness', 'status', 'prompt', 'model', 'effort', 'cli_version', 'price_table_version', 'cost_source', 'prompt_sha256', 'account_label', 'machine_label', 'auth_mode', 'process_ownership_json', 'summary', 'verdict_json', 'metrics_json', 'cost_usd', 'input_tokens', 'output_tokens', 'num_turns', 'duration_ms', 'session_id', 'revision', 'error', 'created_at', 'started_at', 'finished_at'],
  },
  events: {
    required: ['seq', 'build_id', 'attempt_id', 'ts', 'kind', 'text'],
    allowed: ['seq', 'build_id', 'attempt_id', 'ts', 'kind', 'text', 'agent_id', 'round', 'role', 'channel'],
  },
  reports: {
    required: ['id', 'name', 'data_json', 'created_at', 'updated_at'],
    allowed: ['id', 'name', 'data_json', 'created_at', 'updated_at'],
  },
} as const

/** Returns the vocabulary the validated ledger uses, current or pre-rename. */
function validateImportSchema(db: DatabaseSync): LedgerShape {
  const objects = db
    .prepare("SELECT type, name, tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
    .all() as unknown as { type: string; name: string; tbl_name: string }[]
  const presentTables = new Set(objects.filter((object) => object.type === 'table').map((object) => object.name))
  // A ledger holding both vocabularies is not something this app can write.
  if (presentTables.has('builds') && presentTables.has('loops')) {
    throw new Error('The folder ledger mixes pre-rename and current table names.')
  }
  const shape = presentTables.has('loops') ? LEGACY_SHAPE : CURRENT_SHAPE
  const requiredTables = new Set([shape.builds, shape.attempts, 'events'])
  const allowedTables = new Set([...requiredTables, 'reports'])
  for (const object of objects) {
    if (object.type === 'trigger' || object.type === 'view') throw new Error('The folder ledger contains executable or computed schema objects.')
    if (object.type === 'table' && !allowedTables.has(object.name)) throw new Error(`The folder ledger contains an unsupported table: ${object.name}.`)
    if (object.type === 'index') {
      const expected = object.name === shape.attemptsIndex
        ? { table: shape.attempts, columns: [shape.buildId, 'created_at'] }
        : object.name === shape.eventsIndex
          ? { table: 'events', columns: [shape.buildId, 'seq'] }
          : null
      if (!expected || object.tbl_name !== expected.table) {
        throw new Error(`The folder ledger contains an unsupported index: ${object.name}.`)
      }
      const columns = (db.prepare(`PRAGMA index_info(${object.name})`).all() as unknown as { name: string | null }[])
        .map((column) => column.name)
      const properties = (db.prepare(`PRAGMA index_list(${expected.table})`).all() as unknown as {
        name: string
        unique: number
        partial: number
        origin: string
      }[]).find((index) => index.name === object.name)
      if (
        columns.length !== expected.columns.length ||
        columns.some((column, index) => column !== expected.columns[index]) ||
        !properties || properties.unique !== 0 || properties.partial !== 0 || properties.origin !== 'c'
      ) {
        throw new Error(`The folder ledger contains an unsupported index definition: ${object.name}.`)
      }
    } else if (object.type !== 'table') {
      throw new Error(`The folder ledger contains an unsupported schema object: ${object.name}.`)
    }
  }
  const specs: Array<[string, { required: readonly string[]; allowed: readonly string[] }]> = [
    [shape.builds, IMPORT_COLUMNS.builds],
    [shape.attempts, IMPORT_COLUMNS.phase_attempts],
    ['events', IMPORT_COLUMNS.events],
    ...(presentTables.has('reports') ? [['reports', IMPORT_COLUMNS.reports] as [string, typeof IMPORT_COLUMNS.reports]] : []),
  ]
  for (const [table, spec] of specs) {
    const columnInfo = db.prepare(`PRAGMA table_xinfo(${table})`).all() as unknown as { name: string; pk: number; hidden: number }[]
    if (columnInfo.some((column) => column.hidden !== 0)) {
      throw new Error(`The folder ledger ${table} table contains generated or hidden columns.`)
    }
    const columns = columnInfo.map((column) => column.name)
    const required = shapedColumns(spec.required, shape)
    const allowed = shapedColumns(spec.allowed, shape)
    if (required.some((name) => !columns.includes(name))) throw new Error(`The folder ledger has an unsupported ${table} schema.`)
    if (columns.some((column) => !allowed.includes(column))) {
      throw new Error(`The folder ledger was created by a newer, unsupported schema.`)
    }
    const primary = table === 'events' ? 'seq' : 'id'
    if (columnInfo.find((column) => column.name === primary)?.pk !== 1) {
      throw new Error(`The folder ledger ${table}.${primary} primary-key constraint is missing.`)
    }
  }
  // Run integrity validation only after inert schema shape is proven. SQLite
  // may evaluate a virtual generated expression during quick_check.
  const integrity = db.prepare('PRAGMA quick_check(1)').get() as Record<string, unknown> | undefined
  if (!integrity || !Object.values(integrity).includes('ok')) throw new Error('The folder ledger failed SQLite integrity validation.')
  return shape
}

function countRows(db: DatabaseSync, table: string, maximum: number): void {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  if (!Number.isSafeInteger(row.count) || row.count > maximum) throw new Error(`The folder ledger contains too many ${table} rows.`)
}

/**
 * Prove the untrusted snapshot is inert, then rename it into current
 * vocabulary. Validation stays first: it is what rejects triggers and views,
 * and `ALTER TABLE` re-parses trigger bodies.
 */
function validateAndMigrateImport(db: DatabaseSync): void {
  validateImportSchema(db)
  migrateLegacyNames(db, null)
}

function readImportedRows(db: DatabaseSync): ImportedRows {
  validateAndMigrateImport(db)
  countRows(db, 'builds', MAX_IMPORT_BUILDS)
  countRows(db, 'phase_attempts', MAX_IMPORT_ATTEMPTS)
  countRows(db, 'events', MAX_IMPORT_EVENTS)
  const reportTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'reports'").get()
  if (reportTable) countRows(db, 'reports', 10_000)
  const builds: BuildRow[] = []
  for (const raw of db.prepare('SELECT * FROM builds ORDER BY created_at DESC, rowid DESC').iterate() as unknown as Iterable<unknown>) {
    builds.push(normalizeBuildRow(raw))
  }
  if (builds.length === 0) throw new Error('The folder ledger does not contain any builds.')
  const buildIds = new Set(builds.map((build) => build.id))
  if (buildIds.size !== builds.length) throw new Error('The folder ledger contains duplicate build ids.')
  const runLoop = new Map<string, string>()
  const attemptsByBuild = new Map<string, AttemptRow[]>(builds.map((build) => [build.id, []]))
  for (const raw of db.prepare('SELECT * FROM phase_attempts ORDER BY created_at ASC, rowid ASC').iterate() as unknown as Iterable<unknown>) {
    const attempt = normalizeAttemptRow(raw)
    if (!buildIds.has(attempt.build_id)) throw new Error(`Attempt ${attempt.id} refers to a missing build.`)
    if (runLoop.has(attempt.id)) throw new Error(`The folder ledger contains duplicate build id ${attempt.id}.`)
    runLoop.set(attempt.id, attempt.build_id)
    attemptsByBuild.get(attempt.build_id)!.push(attempt)
  }
  const eventsByBuild = new Map<string, EventRow[]>(builds.map((build) => [build.id, []]))
  const eventSequences = new Set<number>()
  for (const raw of db.prepare('SELECT * FROM events ORDER BY seq ASC').iterate() as unknown as Iterable<unknown>) {
    const event = normalizeEventRow(raw)
    if (eventSequences.has(event.seq)) throw new Error(`The folder ledger contains duplicate event sequence ${event.seq}.`)
    eventSequences.add(event.seq)
    if (!buildIds.has(event.build_id)) throw new Error(`Event ${event.seq} refers to a missing build.`)
    if (event.attempt_id && runLoop.get(event.attempt_id) !== event.build_id) throw new Error(`Event ${event.seq} refers to a missing or unrelated build.`)
    eventsByBuild.get(event.build_id)!.push(event)
  }
  return { builds, attemptsByBuild, eventsByBuild }
}

/**
 * A legacy row has no inode to compare, so its portable mirror is the proof
 * that the directory currently at the saved path is the project we recorded.
 * Validate the complete inert schema first, then compare immutable registry
 * keys before binding that directory's current filesystem identity.
 */
function assertLegacyWorkspaceMatchesRegistry(db: DatabaseSync, workspaceDir: string, portableDb: DatabaseSync): void {
  validateAndMigrateImport(portableDb)
  countRows(portableDb, 'builds', MAX_IMPORT_BUILDS)
  countRows(portableDb, 'phase_attempts', MAX_IMPORT_ATTEMPTS)
  countRows(portableDb, 'events', MAX_IMPORT_EVENTS)
  const reportTable = portableDb.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'reports'").get()
  if (reportTable) countRows(portableDb, 'reports', 10_000)

  const registryBuilds = db.prepare(
    'SELECT id, prompt, created_at FROM builds WHERE workspace_dir = ? ORDER BY id',
  ).all(workspaceDir) as unknown as Array<{ id: string; prompt: string; created_at: string }>
  const portableBuilds = portableDb.prepare(
    'SELECT id, prompt, created_at, workspace_dir FROM builds ORDER BY id',
  ).all() as unknown as Array<{ id: string; prompt: string; created_at: string; workspace_dir: string }>
  if (registryBuilds.length === 0 || registryBuilds.length !== portableBuilds.length) {
    throw new Error('The legacy folder ledger does not match the registered build histories.')
  }
  for (let index = 0; index < registryBuilds.length; index += 1) {
    const registry = registryBuilds[index]
    const portable = portableBuilds[index]
    if (
      registry.id !== portable.id
      || portable.workspace_dir !== workspaceDir
      || registry.created_at !== portable.created_at
      || registry.prompt !== portable.prompt
    ) throw new Error('The legacy folder ledger does not match the registered build histories.')
  }

  const registryAttempts = db.prepare(
    `SELECT phase_attempts.id, phase_attempts.build_id, phase_attempts.created_at
     FROM phase_attempts JOIN builds ON builds.id = phase_attempts.build_id
     WHERE builds.workspace_dir = ?
     ORDER BY phase_attempts.id`,
  ).all(workspaceDir) as unknown as Array<{ id: string; build_id: string; created_at: string }>
  const portableAttempts = portableDb.prepare(
    'SELECT id, build_id, created_at FROM phase_attempts ORDER BY id',
  ).all() as unknown as Array<{ id: string; build_id: string; created_at: string }>
  if (registryAttempts.length !== portableAttempts.length) {
    throw new Error('The legacy folder ledger does not match the registered attempt histories.')
  }
  for (let index = 0; index < registryAttempts.length; index += 1) {
    const registry = registryAttempts[index]
    const portable = portableAttempts[index]
    if (
      registry.id !== portable.id
      || registry.build_id !== portable.build_id
      || registry.created_at !== portable.created_at
    ) throw new Error('The legacy folder ledger does not match the registered attempt histories.')
  }
}

function putBuildRow(db: DatabaseSync, row: BuildRow, workspaceDir = row.workspace_dir): void {
  db.prepare(
    `INSERT OR REPLACE INTO builds
      (id, title, prompt, workspace_dir, workspace_dev, workspace_ino, max_rounds, budget_usd, models_json, status, round, total_cost_usd, stop_reason, created_at, updated_at, play_trusted, execution_trusted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.title,
    row.prompt,
    workspaceDir,
    row.workspace_dev,
    row.workspace_ino,
    row.max_rounds,
    row.budget_usd,
    row.models_json,
    row.status,
    row.round,
    row.total_cost_usd,
    row.stop_reason,
    row.created_at,
    row.updated_at,
    row.play_trusted,
    row.execution_trusted,
  )
}

function putAttemptRow(db: DatabaseSync, row: AttemptRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO phase_attempts
      (id, build_id, round, role, harness, status, prompt, model, effort, cli_version, price_table_version, cost_source,
       prompt_sha256, account_label, machine_label, auth_mode, process_ownership_json,
       summary, verdict_json, metrics_json, cost_usd,
       input_tokens, output_tokens, num_turns, duration_ms, session_id, revision, error, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.build_id,
    row.round,
    row.role,
    row.harness,
    row.status,
    row.prompt,
    row.model,
    row.effort,
    row.cli_version,
    row.price_table_version,
    row.cost_source,
    row.prompt_sha256,
    row.account_label,
    row.machine_label,
    row.auth_mode,
    row.process_ownership_json,
    row.summary,
    row.verdict_json,
    row.metrics_json,
    row.cost_usd,
    row.input_tokens,
    row.output_tokens,
    row.num_turns,
    row.duration_ms,
    row.session_id,
    row.revision,
    row.error,
    row.created_at,
    row.started_at,
    row.finished_at,
  )
}

function putEventRow(db: DatabaseSync, row: EventRow, preserveSeq: boolean): void {
  if (preserveSeq) {
    db.prepare(
      `INSERT OR REPLACE INTO events (seq, build_id, attempt_id, ts, kind, text, agent_id, round, role, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.seq, row.build_id, row.attempt_id, row.ts, row.kind, row.text, row.agent_id ?? null, row.round ?? null, row.role ?? null, row.channel ?? null)
    return
  }
  db.prepare(`INSERT INTO events (build_id, attempt_id, ts, kind, text, agent_id, round, role, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.build_id,
    row.attempt_id,
    row.ts,
    row.kind,
    row.text,
    row.agent_id ?? null,
    row.round ?? null,
    row.role ?? null,
    row.channel ?? null,
  )
}

export function defaultBuildTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  const quoted = compact.match(/["“]([^"”]{1,80})["”]/)?.[1]
  const unquoted = compact
    .replace(/^(?:please\s+)?(?:build|create|make|develop|implement)\s+/i, '')
    .split(/\s+[—–]\s+|:\s+/)[0]
  const candidate = (quoted ?? unquoted).replace(/[.!?]+$/, '').trim().slice(0, 56) || 'Untitled build'
  const normalized = candidate.replace(/-([A-Z])([a-z]+)/g, (_match, initial: string, rest: string) => `-${initial.toLowerCase()}${rest}`)
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function availableBuildTitle(db: DatabaseSync, prompt: string): string {
  const base = defaultBuildTitle(prompt)
  const exists = db.prepare('SELECT 1 FROM builds WHERE title = ? LIMIT 1')
  if (!exists.get(base)) return base
  for (let suffix = 2; suffix <= MAX_MATERIALIZED_BUILD_HISTORY + 1; suffix += 1) {
    const candidate = `${base} (${suffix})`
    if (!exists.get(candidate)) return candidate
  }
  return `${base} (${crypto.randomUUID().slice(0, 8)})`
}

function toBuild(row: BuildRow): BuildRecord {
  const rawModels = parseStoredJson(row.models_json, `Build ${row.id} models`)
  if (!rawModels || typeof rawModels !== 'object' || Array.isArray(rawModels)) throw new Error(`Build ${row.id} models must be an object.`)
  return {
    id: row.id,
    title: redactLogText(row.title || defaultBuildTitle(row.prompt)),
    prompt: redactLogText(row.prompt),
    workspaceDir: row.workspace_dir,
    workspaceIdentity: row.workspace_dev !== null && row.workspace_ino !== null
      ? { dev: row.workspace_dev, ino: row.workspace_ino }
      : null,
    maxRounds: row.max_rounds,
    budgetUsd: row.budget_usd,
    models: normalizeModels(rawModels as Partial<BuildModels>),
    status: row.status as BuildStatus,
    round: row.round,
    totalCostUsd: row.total_cost_usd,
    stopReason: row.stop_reason == null ? null : redactLogText(row.stop_reason),
    playTrusted: row.play_trusted === 1,
    executionTrusted: row.execution_trusted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toAttempt(row: AttemptRow): PhaseAttempt {
  const verdict = row.verdict_json ? normalizeVerdict(parseStoredJson(row.verdict_json, `Attempt ${row.id} verdict`)) : null
  if (row.verdict_json && !verdict) throw new Error(`Attempt ${row.id} verdict does not match the stored verdict contract.`)
  const metrics = row.metrics_json ? normalizeAttemptMetrics(parseStoredJson(row.metrics_json, `Attempt ${row.id} metrics`)) : null
  if (row.metrics_json && !metrics) throw new Error(`Attempt ${row.id} metrics do not match the stored metrics contract.`)
  return {
    id: row.id,
    buildId: row.build_id,
    round: row.round,
    role: row.role as PhaseRole,
    harness: row.harness as 'claude' | 'codex',
    status: row.status as AttemptStatus,
    prompt: redactLogText(row.prompt),
    model: row.model === null ? null : normalizePersistedModel(row.model),
    effort: typeof row.effort === 'string' && EFFORTS.has(row.effort) ? row.effort : null,
    cliVersion: projectedProvenance(row.cli_version, 1_000),
    priceTableVersion: typeof row.price_table_version === 'string' && PRICE_TABLE_VERSION.test(row.price_table_version) ? row.price_table_version : null,
    costSource: projectedProvenance(row.cost_source, 256),
    promptSha256: typeof row.prompt_sha256 === 'string' && SHA256.test(row.prompt_sha256) ? row.prompt_sha256 : null,
    accountLabel: projectedProvenance(row.account_label, 256),
    machineLabel: projectedProvenance(row.machine_label, 256),
    authMode: typeof row.auth_mode === 'string' && AUTH_MODES.has(row.auth_mode) ? row.auth_mode as 'subscription' | 'api_key' : null,
    summary: row.summary == null ? null : redactLogText(row.summary),
    verdict,
    metrics,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    numTurns: row.num_turns,
    durationMs: row.duration_ms,
    sessionId: normalizeSessionId(row.session_id),
    revision: row.revision,
    error: row.error == null ? null : redactLogText(row.error),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export interface AttemptPatch {
  status?: AttemptStatus
  /** Exact effective prompt used for resumed/provenance-bound attempts. */
  prompt?: string
  model?: string | null
  effort?: string | null
  cliVersion?: string | null
  priceTableVersion?: string | null
  costSource?: string | null
  promptSha256?: string | null
  accountLabel?: string | null
  machineLabel?: string | null
  authMode?: 'subscription' | 'api_key' | null
  summary?: string | null
  verdict?: Verdict | null
  metrics?: AttemptMetrics | null
  costUsd?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  numTurns?: number | null
  durationMs?: number | null
  sessionId?: string | null
  revision?: string | null
  error?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export interface AttemptProcessOwnership {
  pid: number
  processIdentity: string
  groupIdentities: string[]
  startedAtMs: number
  outDev: number
  outIno: number
  errDev: number
  errIno: number
}

const MAX_PROCESS_OWNERSHIP_BYTES = 8 * 1024
const MAX_GROUP_IDENTITIES = 256
const PROCESS_LSTART = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|[12]\d|3[01]) \d{2}:\d{2}:\d{2} \d{4}$/

function validProcessIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && PROCESS_LSTART.test(value)
    && Number.isFinite(Date.parse(value))
    && redactLogText(value) === value
}

function normalizeGroupIdentities(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GROUP_IDENTITIES) return null
  const identities: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length > 4_112) return null
    const separator = entry.indexOf(':')
    if (separator <= 0) return null
    const pidText = entry.slice(0, separator)
    const identity = entry.slice(separator + 1)
    const pid = Number(pidText)
    if (!/^\d{1,10}$/.test(pidText) || !Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fff_ffff || !validProcessIdentity(identity)) {
      return null
    }
    identities.push(`${pid}:${identity}`)
  }
  const unique = [...new Set(identities)]
  return unique.length === identities.length ? unique : null
}

function normalizeAttemptProcessOwnership(value: unknown): AttemptProcessOwnership | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PROCESS_OWNERSHIP_BYTES) return null
  } catch {
    return null
  }
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => ![
    'pid', 'processIdentity', 'groupIdentities', 'startedAtMs', 'outDev', 'outIno', 'errDev', 'errIno',
  ].includes(key))) return null
  if (!Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 1 || (raw.pid as number) > 0x7fff_ffff) return null
  if (!validProcessIdentity(raw.processIdentity)) return null
  const groupIdentities = normalizeGroupIdentities(raw.groupIdentities)
  if (!groupIdentities) return null
  if (!Number.isSafeInteger(raw.startedAtMs) || (raw.startedAtMs as number) <= 0) return null
  for (const field of ['outDev', 'outIno', 'errDev', 'errIno'] as const) {
    if (!Number.isSafeInteger(raw[field]) || (raw[field] as number) <= 0) return null
  }
  return {
    pid: raw.pid as number,
    processIdentity: raw.processIdentity,
    groupIdentities,
    startedAtMs: raw.startedAtMs as number,
    outDev: raw.outDev as number,
    outIno: raw.outIno as number,
    errDev: raw.errDev as number,
    errIno: raw.errIno as number,
  }
}

export interface BuildPatch {
  title?: string
  status?: BuildStatus
  round?: number
  totalCostUsd?: number
  stopReason?: string | null
  playTrusted?: boolean
}

export interface LedgerOptions {
  protectedRoots?: () => readonly string[]
}

interface CachedFolderDb {
  db: DatabaseSync
  path: string
  dev: number
  ino: number
}

export class Ledger {
  private db: DatabaseSync
  private folderDbs = new Map<string, CachedFolderDb>()
  private transactionDepth = 0
  private pendingMirrorWrites = new Map<string, Array<(db: DatabaseSync) => void>>()
  private readonly protectedRoots: () => readonly string[]

  private trimFolderDbCache(): void {
    if (this.transactionDepth !== 0) return
    while (this.folderDbs.size > MAX_OPEN_FOLDER_DATABASES) {
      const oldest = this.folderDbs.entries().next().value as [string, CachedFolderDb] | undefined
      if (!oldest) return
      const [workspaceDir, cached] = oldest
      cached.db.close()
      this.folderDbs.delete(workspaceDir)
    }
  }

  constructor(dbPath: string, options: LedgerOptions = {}) {
    this.protectedRoots = options.protectedRoots ?? (() => [])
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    // Only the registry needs a pre-rename backup. A project-folder mirror is
    // rebuilt from canonical rows, so there is nothing there to lose.
    initializeSchema(this.db, 'WAL', `${dbPath}.pre-build-rename`)
    this.adoptLegacyWorkspaceIdentities()
    this.migrateRegisteredMetadataDirectories()
    this.repairExistingMirrors()
  }

  /**
   * Bind pre-identity, untrusted histories to their existing project folder.
   * Invalid, missing, aliased, protected, or mismatched folders remain null
   * and therefore continue to fail closed at every filesystem/execute seam.
   */
  private adoptLegacyWorkspaceIdentities(): void {
    const page = this.db.prepare(
      `SELECT workspace_dir
       FROM builds
       WHERE play_trusted = 0 AND workspace_dev IS NULL AND workspace_ino IS NULL
         AND (? IS NULL OR workspace_dir > ?)
       GROUP BY workspace_dir
       ORDER BY workspace_dir
       LIMIT 100`,
    )
    const conflictingIdentity = this.db.prepare(
      `SELECT 1
       FROM builds
       WHERE workspace_dir = ? AND (
         (workspace_dev IS NULL AND workspace_ino IS NOT NULL)
         OR (workspace_dev IS NOT NULL AND workspace_ino IS NULL)
         OR (workspace_dev IS NOT NULL AND workspace_ino IS NOT NULL AND (workspace_dev != ? OR workspace_ino != ?))
       )
       LIMIT 1`,
    )
    const adopt = this.db.prepare(
      `UPDATE builds SET workspace_dev = ?, workspace_ino = ?
       WHERE workspace_dir = ? AND play_trusted = 0 AND workspace_dev IS NULL AND workspace_ino IS NULL`,
    )
    const buildsInWorkspace = this.db.prepare('SELECT id FROM builds WHERE workspace_dir = ? ORDER BY id')
    const identityFailureExists = this.db.prepare(
      "SELECT 1 FROM events WHERE build_id = ? AND kind = 'workspace-identity' AND text = ? LIMIT 1",
    )
    const insertIdentityFailure = this.db.prepare(
      "INSERT INTO events (build_id, attempt_id, ts, kind, text, channel) VALUES (?, NULL, ?, 'workspace-identity', ?, 'error')",
    )
    let cursor: string | null = null
    while (true) {
      const candidates = page.all(cursor, cursor) as unknown as Array<{ workspace_dir: string }>
      if (candidates.length === 0) return
      for (const { workspace_dir: workspaceDir } of candidates) {
        let snapshot: ReturnType<typeof snapshotBuildLedger> | null = null
        try {
          const captured = captureWorkspaceIdentity(workspaceDir, this.protectedRoots())
          if (captured.workspaceDir !== workspaceDir || path.resolve(workspaceDir) !== workspaceDir) {
            throw new Error('The legacy workspace path is no longer canonical.')
          }
          if (conflictingIdentity.get(
            workspaceDir,
            captured.workspaceIdentity.dev,
            captured.workspaceIdentity.ino,
          )) throw new Error('Registered histories disagree about the workspace identity.')

          snapshot = snapshotBuildLedger(workspaceDir)
          // Writable because validation migrates pre-rename table names in this
          // private temp copy. The user's file is never touched.
          const portable = new DatabaseSync(snapshot.ledgerPath)
          try {
            assertLegacyWorkspaceMatchesRegistry(this.db, workspaceDir, portable)
          } finally {
            portable.close()
          }

          this.db.exec('BEGIN IMMEDIATE')
          let committed = false
          try {
            // Catch a directory swap between validation and durable adoption.
            assertBuildWorkspaceIdentity(captured, this.protectedRoots())
            adopt.run(captured.workspaceIdentity.dev, captured.workspaceIdentity.ino, workspaceDir)
            assertBuildWorkspaceIdentity(captured, this.protectedRoots())
            this.db.exec('COMMIT')
            committed = true
          } finally {
            if (!committed) this.db.exec('ROLLBACK')
          }
        } catch (error) {
          // Compatibility adoption is best-effort and fail-closed. Persist
          // the reason once so an operator can distinguish missing history,
          // an unsafe path, and a folder-ledger mismatch.
          const message = `Legacy workspace identity was not adopted: ${redactLogText(error instanceof Error ? error.message : String(error)).slice(0, 4_000)}`
          const timestamp = now()
          for (const { id } of buildsInWorkspace.iterate(workspaceDir) as unknown as Iterable<{ id: string }>) {
            if (!identityFailureExists.get(id, message)) insertIdentityFailure.run(id, timestamp, message)
          }
        } finally {
          snapshot?.cleanup()
        }
      }
      cursor = candidates.at(-1)!.workspace_dir
    }
  }

  /** Rename legacy metadata only after this registry has proved the workspace identity. */
  private migrateRegisteredMetadataDirectories(): void {
    const workspaces = this.db.prepare('SELECT MIN(id) AS id, workspace_dir FROM builds GROUP BY workspace_dir')
    for (const { id, workspace_dir: workspaceDir } of workspaces.iterate() as unknown as Iterable<{ id: string; workspace_dir: string }>) {
      try {
        this.assertBuildWorkspaceIdentity(id)
        migrateBuildMetadataDir(workspaceDir)
      } catch {
        // Identity adoption and mirror repair record actionable failures. An
        // unproved path must never be renamed merely because it is registered.
      }
    }
  }

  /** Canonical registry wins after a crash between separate SQLite commits. */
  private repairExistingMirrors(): void {
    const workspaces = this.db.prepare('SELECT MIN(id) AS id, workspace_dir FROM builds GROUP BY workspace_dir')
    const buildIds = this.db.prepare('SELECT id FROM builds WHERE workspace_dir = ? ORDER BY id')
    for (const { id, workspace_dir: workspaceDir } of workspaces.iterate() as unknown as Iterable<{ id: string; workspace_dir: string }>) {
      try {
        this.assertBuildWorkspaceIdentity(id)
        // Do not create metadata in a missing/retired workspace, but a missing
        // mirror inside an existing workspace must be rebuilt from canonical.
        if (fs.existsSync(workspaceDir)) this.syncWorkspaceFolder(workspaceDir)
      } catch (error) {
        const message = `Portable ledger repair failed: ${redactLogText(error instanceof Error ? error.message : String(error)).slice(0, 4_000)}`
        for (const build of buildIds.iterate(workspaceDir) as unknown as Iterable<{ id: string }>) {
          const exists = this.db.prepare("SELECT 1 FROM events WHERE build_id = ? AND kind = 'mirror-repair' AND text = ? LIMIT 1").get(build.id, message)
          if (!exists) {
            this.db.prepare("INSERT INTO events (build_id, attempt_id, ts, kind, text, channel) VALUES (?, NULL, ?, 'mirror-repair', ?, 'error')")
              .run(build.id, now(), message)
          }
        }
      }
    }
  }

  private openFolderDb(workspaceDir: string): DatabaseSync {
    workspaceDir = canonicalizePath(workspaceDir)
    assertWorkspaceBoundary(workspaceDir, this.protectedRoots())
    const registered = this.db.prepare('SELECT id FROM builds WHERE workspace_dir = ? ORDER BY id LIMIT 1').get(workspaceDir) as { id: string } | undefined
    if (registered) this.assertBuildWorkspaceIdentity(registered.id)
    const metadataDir = safeWorkspaceMetadataDir(workspaceDir, [], true)
    const dbPath = path.join(metadataDir, 'ledger.db')
    const existing = this.folderDbs.get(workspaceDir)
    if (existing) {
      try {
        const stat = fs.lstatSync(dbPath)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== existing.dev || stat.ino !== existing.ino) {
          throw new Error('Cached folder ledger identity changed.')
        }
        // Refresh insertion order so the bounded cache evicts the least
        // recently used inactive workspace after the enclosing transaction.
        this.folderDbs.delete(workspaceDir)
        this.folderDbs.set(workspaceDir, existing)
        return existing.db
      } catch (error) {
        try {
          existing.db.close()
        } catch {
          /* the stale handle may already be closed */
        }
        this.folderDbs.delete(workspaceDir)
        throw new Error(`Cached portable ledger changed identity; the competing entry was preserved and file access is blocked: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Never open an agent-replaced SQLite schema. Reclaim the exact app-owned
    // mirror path, initialize a fresh database, then rebuild it from canonical.
    const candidates = [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`]
    for (const candidate of candidates) assertSafeWorkspaceFile(candidate)
    const registryOwnsWorkspace = registered !== undefined
    if (!registryOwnsWorkspace && candidates.some((candidate) => fs.existsSync(candidate))) {
      throw new Error('This workspace already contains an unregistered portable ledger. Import its history before starting a new build here.')
    }
    if (registryOwnsWorkspace) {
      this.publishWorkspaceFolderAtomically(workspaceDir)
      const rebuilt = this.folderDbs.get(workspaceDir)
      if (!rebuilt) throw new Error('Portable ledger rebuild did not open the published mirror.')
      return rebuilt.db
    }
    const claim = fs.openSync(dbPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    const claimed = fs.fstatSync(claim)
    fs.closeSync(claim)
    const db = new DatabaseSync(dbPath)
    try {
      const opened = fs.lstatSync(dbPath)
      if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || opened.dev !== claimed.dev || opened.ino !== claimed.ino) {
        throw new Error('Folder ledger path changed while SQLite was opening it.')
      }
      initializeSchema(db, 'DELETE')
      this.rebuildFolderDb(db, workspaceDir)
      this.folderDbs.set(workspaceDir, { db, path: dbPath, dev: opened.dev, ino: opened.ino })
      this.trimFolderDbCache()
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  private rebuildFolderDb(folderDb: DatabaseSync, workspaceDir: string): void {
    const builds = this.db.prepare('SELECT * FROM builds WHERE workspace_dir = ? ORDER BY created_at ASC, rowid ASC')
    const attempts = this.db.prepare('SELECT * FROM phase_attempts WHERE build_id = ? ORDER BY created_at ASC, rowid ASC')
    const events = this.db.prepare('SELECT * FROM events WHERE build_id = ? ORDER BY seq ASC')
    folderDb.exec('BEGIN IMMEDIATE')
    try {
      folderDb.exec('DELETE FROM events; DELETE FROM phase_attempts; DELETE FROM builds;')
      for (const build of builds.iterate(workspaceDir) as unknown as Iterable<BuildRow>) {
        putBuildRow(folderDb, build)
        for (const attempt of attempts.iterate(build.id) as unknown as Iterable<AttemptRow>) putAttemptRow(folderDb, attempt)
        for (const event of events.iterate(build.id) as unknown as Iterable<EventRow>) putEventRow(folderDb, event, true)
      }
      folderDb.exec('COMMIT')
    } catch (error) {
      folderDb.exec('ROLLBACK')
      throw error
    }
  }

  private workspaceForBuild(buildId: string): string | null {
    const row = this.db.prepare('SELECT workspace_dir FROM builds WHERE id = ?').get(buildId) as { workspace_dir: string } | undefined
    return row?.workspace_dir ?? null
  }

  private ensureFolderDbForBuild(buildId: string): DatabaseSync | null {
    const workspaceDir = this.workspaceForBuild(buildId)
    if (!workspaceDir) return null
    const existed = fs.existsSync(buildLedgerPath(workspaceDir))
    const db = this.openFolderDb(workspaceDir)
    if (!existed) this.syncWorkspaceFolder(workspaceDir)
    return db
  }

  private mirrorBuild(buildId: string, write: (db: DatabaseSync) => void): void {
    const workspaceDir = this.workspaceForBuild(buildId)
    if (!workspaceDir) return
    if (this.transactionDepth > 0) {
      const writes = this.pendingMirrorWrites.get(workspaceDir) ?? []
      writes.push(write)
      this.pendingMirrorWrites.set(workspaceDir, writes)
      return
    }
    const folderDb = this.ensureFolderDbForBuild(buildId)
    if (folderDb) write(folderDb)
  }

  /**
   * Atomically apply a synchronous multi-row registry transition. Folder
   * writes are staged in matching folder transactions before the canonical
   * registry commits. This keeps single-event writes incremental rather than
   * rebuilding an ever-growing event table for every log line.
   */
  transaction<T>(work: () => T): T {
    if (this.transactionDepth > 0) return work()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth = 1
    const folderTransactions: Array<{ workspaceDir: string; db: DatabaseSync; committed: boolean }> = []
    const deferredMirrors = new Set<string>()
    const affectedWorkspaces = new Set<string>()
    let canonicalCommitted = false
    let result!: T
    try {
      result = work()
      for (const [workspaceDir, writes] of this.pendingMirrorWrites) {
        affectedWorkspaces.add(workspaceDir)
        if (!fs.existsSync(buildLedgerPath(workspaceDir))) {
          deferredMirrors.add(workspaceDir)
          continue
        }
        const folderDb = this.openFolderDb(workspaceDir)
        folderDb.exec('BEGIN IMMEDIATE')
        const folderTransaction = { workspaceDir, db: folderDb, committed: false }
        folderTransactions.push(folderTransaction)
        for (const write of writes) write(folderDb)
      }
      // Canonical first: a power loss from here onward leaves a registered
      // history that startup can deterministically mirror. Portable-first
      // ordering could leave an orphan database that the registry cannot find.
      this.db.exec('COMMIT')
      canonicalCommitted = true
      for (const folderTransaction of folderTransactions) {
        folderTransaction.db.exec('COMMIT')
        folderTransaction.committed = true
      }
      for (const workspaceDir of deferredMirrors) this.syncWorkspaceFolder(workspaceDir)
      this.transactionDepth = 0
      this.pendingMirrorWrites.clear()
      this.trimFolderDbCache()
      return result
    } catch (error) {
      for (const folderTransaction of folderTransactions) {
        if (folderTransaction.committed) continue
        try {
          folderTransaction.db.exec('ROLLBACK')
        } catch {
          /* the folder transaction may have failed before BEGIN completed */
        }
      }
      if (this.transactionDepth > 0 && !canonicalCommitted) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          /* preserve the originating mirror/transition error */
        }
      }
      this.transactionDepth = 0
      this.pendingMirrorWrites.clear()
      if (canonicalCommitted) {
        const detail = redactLogText(error instanceof Error ? error.message : String(error)).slice(0, 3_000)
        const failedRepairs: string[] = []
        for (const workspaceDir of affectedWorkspaces) {
          const message = `Portable ledger commit failed after the canonical registry committed; repair was required: ${detail}`
          const builds = this.db.prepare('SELECT id FROM builds WHERE workspace_dir = ? ORDER BY id')
          for (const build of builds.iterate(workspaceDir) as unknown as Iterable<{ id: string }>) {
            this.db.prepare("INSERT INTO events (build_id, attempt_id, ts, kind, text, channel) VALUES (?, NULL, ?, 'mirror-repair', ?, 'error')")
              .run(build.id, now(), message)
          }
          try {
            this.syncWorkspaceFolder(workspaceDir)
          } catch (repairError) {
            failedRepairs.push(redactLogText(repairError instanceof Error ? repairError.message : String(repairError)).slice(0, 1_000))
          }
        }
        this.trimFolderDbCache()
        if (failedRepairs.length === 0) return result
        throw new Error(
          `The canonical registry committed, but its portable mirror still needs repair: ${failedRepairs.join('; ')}`,
          { cause: error },
        )
      }
      this.trimFolderDbCache()
      throw error
    }
  }

  private syncWorkspaceFolder(workspaceDir: string): void {
    workspaceDir = canonicalizePath(workspaceDir)
    const folderDb = this.openFolderDb(workspaceDir)
    this.rebuildFolderDb(folderDb, workspaceDir)
  }

  /** Build a complete portable mirror before atomically replacing its main DB. */
  private publishWorkspaceFolderAtomically(
    workspaceDir: string,
    expectedSource?: readonly BuildLedgerSourceIdentity[],
  ): void {
    workspaceDir = canonicalizePath(workspaceDir)
    assertWorkspaceBoundary(workspaceDir, this.protectedRoots())
    const registered = this.db.prepare('SELECT id FROM builds WHERE workspace_dir = ? ORDER BY id LIMIT 1').get(workspaceDir) as { id: string } | undefined
    if (registered) this.assertBuildWorkspaceIdentity(registered.id)
    const metadataDir = safeWorkspaceMetadataDir(workspaceDir, [], true)
    let recoveryFiles = 0
    let recoveryBytes = 0
    const recoveryEntries = fs.opendirSync(metadataDir)
    try {
      while (true) {
        const entry = recoveryEntries.readSync()
        if (!entry) break
        if (!MIRROR_RECOVERY_NAME.test(entry.name)) continue
        const recoveryPath = path.join(metadataDir, entry.name)
        const stat = fs.lstatSync(recoveryPath)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw new Error(`Retained portable-ledger recovery entry is unsafe: ${recoveryPath}`)
        }
        recoveryFiles += 1
        recoveryBytes += stat.size
        if (
          recoveryFiles >= MAX_RETAINED_MIRROR_RECOVERY_FILES
          || !Number.isSafeInteger(recoveryBytes)
          || recoveryBytes >= MAX_RETAINED_MIRROR_RECOVERY_BYTES
        ) {
          throw new Error(
            `Portable-ledger recovery storage reached its safety limit. Preserve and then manually remove retained .ledger.*.recovery files under ${metadataDir} before retrying.`,
          )
        }
      }
    } finally {
      recoveryEntries.closeSync()
    }
    const dbPath = path.join(metadataDir, 'ledger.db')
    const candidates = [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`]
    const expectedBySuffix = new Map(expectedSource?.map((entry) => [entry.suffix, entry.identity]) ?? [])
    const identities = new Map<string, NonNullable<BuildLedgerSourceIdentity['identity']> | null>()
    for (const [index, candidate] of candidates.entries()) {
      assertSafeWorkspaceFile(candidate)
      try {
        const stat = fs.lstatSync(candidate, { bigint: true })
        const identity = {
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          mtimeNs: stat.mtimeNs,
          ctimeNs: stat.ctimeNs,
          nlink: stat.nlink,
        }
        const suffix = (index === 0 ? '' : path.basename(candidate).slice('ledger.db'.length)) as BuildLedgerSourceIdentity['suffix']
        const expected = expectedBySuffix.get(suffix)
        if (expectedSource && (!expected
          || expected.dev !== identity.dev
          || expected.ino !== identity.ino
          || expected.size !== identity.size
          || expected.mtimeNs !== identity.mtimeNs
          || expected.ctimeNs !== identity.ctimeNs
          || expected.nlink !== identity.nlink)) {
          throw new Error('The selected portable ledger changed after its import snapshot was captured.')
        }
        identities.set(candidate, identity)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const suffix = (index === 0 ? '' : path.basename(candidate).slice('ledger.db'.length)) as BuildLedgerSourceIdentity['suffix']
        if (expectedSource && expectedBySuffix.get(suffix) !== null) {
          throw new Error('The selected portable ledger changed after its import snapshot was captured.')
        }
        identities.set(candidate, null)
      }
    }

    const cached = this.folderDbs.get(workspaceDir)
    cached?.db.close()
    this.folderDbs.delete(workspaceDir)
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-ledger-publish-'))
    fs.chmodSync(temporaryDir, 0o700)
    const temporary = path.join(temporaryDir, 'ledger.db')
    let temporaryDb: DatabaseSync | null = null
    const recovered: string[] = []
    let priorEntriesClaimed = false
    try {
      const claim = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      )
      fs.closeSync(claim)
      temporaryDb = new DatabaseSync(temporary)
      initializeSchema(temporaryDb, 'DELETE')
      this.rebuildFolderDb(temporaryDb, workspaceDir)
      temporaryDb.close()
      temporaryDb = null
      const built = fs.lstatSync(temporary)
      if (!built.isFile() || built.isSymbolicLink() || built.nlink !== 1) {
        throw new Error('Completed portable ledger is not a unique regular file.')
      }

      // Move every previously validated entry to a unique recovery name. A
      // source-path racer is moved and preserved, then rejected by the inode
      // comparison. No existing canonical entry is ever overwritten/unlinked.
      for (const candidate of candidates) {
        const expected = identities.get(candidate) ?? null
        if (expected === null) {
          try {
            fs.lstatSync(candidate)
            throw new Error('A portable-ledger entry appeared while the normalized mirror was being built.')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            throw error
          }
        }
        const recovery = path.join(metadataDir, `.ledger.${crypto.randomUUID()}.${path.basename(candidate)}.recovery`)
        try {
          const current = fs.lstatSync(candidate, { bigint: true })
          if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
            || current.dev !== expected.dev || current.ino !== expected.ino
            || current.size !== expected.size || current.mtimeNs !== expected.mtimeNs || current.ctimeNs !== expected.ctimeNs) {
            throw new Error('Portable ledger changed while the normalized mirror was being built.')
          }
          // The random recovery target is not published before this synchronous
          // syscall, so a workspace process cannot predictably preclaim it.
          fs.renameSync(candidate, recovery)
          const moved = fs.lstatSync(recovery, { bigint: true })
          if (!moved.isFile() || moved.isSymbolicLink() || moved.nlink !== 1n
            || moved.dev !== expected.dev || moved.ino !== expected.ino
            || moved.size !== expected.size || moved.mtimeNs !== expected.mtimeNs) {
            throw new Error('Portable ledger changed while its prior entry was retained for recovery.')
          }
          recovered.push(recovery)
        } catch (error) {
          throw error
        }
      }
      priorEntriesClaimed = true
      // COPYFILE_EXCL is the no-clobber publish. A concurrent main-database
      // claimant survives and makes the import fail instead of being replaced.
      fs.copyFileSync(temporary, dbPath, fs.constants.COPYFILE_EXCL)
      const publishedFd = fs.openSync(dbPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0))
      try {
        fs.fsyncSync(publishedFd)
      } finally {
        fs.closeSync(publishedFd)
      }
      for (const sidecar of candidates.slice(1)) {
        try {
          fs.lstatSync(sidecar)
          throw new Error('A portable-ledger sidecar appeared during exclusive publication.')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      const directoryFd = fs.openSync(metadataDir, fs.constants.O_RDONLY)
      try {
        fs.fsyncSync(directoryFd)
      } finally {
        fs.closeSync(directoryFd)
      }

      const opened = fs.lstatSync(dbPath)
      const db = new DatabaseSync(dbPath)
      const afterOpen = fs.lstatSync(dbPath)
      if (
        !opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1
        || !afterOpen.isFile() || afterOpen.isSymbolicLink() || afterOpen.nlink !== 1
        || afterOpen.dev !== opened.dev || afterOpen.ino !== opened.ino
      ) {
        db.close()
        throw new Error('Portable ledger path changed while SQLite was opening the published mirror.')
      }
      this.folderDbs.set(workspaceDir, { db, path: dbPath, dev: opened.dev, ino: opened.ino })
      this.trimFolderDbCache()
    } catch (error) {
      try {
        temporaryDb?.close()
      } catch {
        /* preserve the publication error */
      }
      // Once every prior entry has been moved aside, any pathname that appears
      // here is either our just-published mirror or a concurrent claimant.
      // Preserve it under an unpredictable recovery name so an import rollback
      // can restore its exact private snapshot only into absent names. Never
      // unlink or overwrite the raced entry.
      if (priorEntriesClaimed) {
        for (const candidate of candidates) {
          const recovery = path.join(metadataDir, `.ledger.${crypto.randomUUID()}.${path.basename(candidate)}.recovery`)
          try {
            fs.renameSync(candidate, recovery)
            recovered.push(recovery)
          } catch (moveError) {
            if ((moveError as NodeJS.ErrnoException).code !== 'ENOENT') {
              recovered.push(`${candidate} (could not be retained automatically)`)
            }
          }
        }
      }
      const detail = error instanceof Error ? error.message : String(error)
      const recovery = recovered.length > 0 ? ` Prior entries were retained at: ${recovered.join(', ')}` : ''
      throw new Error(`${detail}${recovery}`, { cause: error })
    } finally {
      fs.rmSync(temporaryDir, { recursive: true, force: true })
    }
  }

  createBuild(input: {
    prompt: string
    workspaceDir: string
    maxRounds: number
    budgetUsd: number | null
    models: BuildModels
  }): BuildRecord {
    if (this.transactionDepth === 0) return this.transaction(() => this.createBuild(input))
    const id = crypto.randomUUID()
    const ts = now()
    const capturedWorkspace = captureWorkspaceIdentity(input.workspaceDir, this.protectedRoots())
    const workspaceDir = capturedWorkspace.workspaceDir
    // Validate the metadata boundary before canonical mutation, but do not
    // create a first portable database yet. Canonical commit must precede the
    // first mirror publication so a crash cannot leave an orphan ledger.
    const registered = this.db.prepare('SELECT 1 FROM builds WHERE workspace_dir = ? LIMIT 1').get(workspaceDir)
    if (!registered) {
      const metadataDir = safeWorkspaceMetadataDir(workspaceDir, [], true)
      const portablePath = path.join(metadataDir, 'ledger.db')
      for (const candidate of [portablePath, `${portablePath}-journal`, `${portablePath}-wal`, `${portablePath}-shm`]) {
        assertSafeWorkspaceFile(candidate)
      }
      try {
        fs.lstatSync(portablePath)
        throw new Error('This workspace already contains an unregistered portable ledger. Import its history before starting a new build.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    this.db
      .prepare(
        `INSERT INTO builds (id, title, prompt, workspace_dir, workspace_dev, workspace_ino, max_rounds, budget_usd, models_json, status, round, total_cost_usd, created_at, updated_at, play_trusted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, 0, ?, ?, 1)`,
      )
      .run(
        id,
        availableBuildTitle(this.db, redactLogText(input.prompt)),
        redactLogText(input.prompt),
        workspaceDir,
        capturedWorkspace.workspaceIdentity.dev,
        capturedWorkspace.workspaceIdentity.ino,
        input.maxRounds,
        input.budgetUsd,
        JSON.stringify(input.models),
        ts,
        ts,
      )
    const row = this.db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as unknown as BuildRow
    this.mirrorBuild(id, (folderDb) => putBuildRow(folderDb, row))
    return this.getBuild(id)!
  }

  patchBuild(id: string, patch: BuildPatch): void {
    if (this.transactionDepth === 0) return this.transaction(() => this.patchBuild(id, patch))
    const sets: string[] = ['updated_at = ?']
    const values: (string | number | null)[] = [now()]
    if (patch.title !== undefined) (sets.push('title = ?'), values.push(redactLogText(patch.title)))
    if (patch.status !== undefined) (sets.push('status = ?'), values.push(patch.status))
    if (patch.round !== undefined) (sets.push('round = ?'), values.push(patch.round))
    if (patch.totalCostUsd !== undefined) (sets.push('total_cost_usd = ?'), values.push(patch.totalCostUsd))
    if (patch.stopReason !== undefined) (sets.push('stop_reason = ?'), values.push(patch.stopReason == null ? null : redactLogText(patch.stopReason)))
    if (patch.playTrusted !== undefined) (sets.push('play_trusted = ?'), values.push(patch.playTrusted ? 1 : 0))
    this.db.prepare(`UPDATE builds SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    const row = this.db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as BuildRow | undefined
    if (row) this.mirrorBuild(id, (folderDb) => putBuildRow(folderDb, row))
  }

  getBuild(id: string): BuildRecord | null {
    const row = this.db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as BuildRow | undefined
    return row ? toBuild(row) : null
  }

  /** Revalidate a canonical registry row before any execution or file access. */
  assertBuildWorkspaceIdentity(id: string): string {
    const row = this.db.prepare(
      'SELECT workspace_dir, workspace_dev, workspace_ino FROM builds WHERE id = ?',
    ).get(id) as Pick<BuildRow, 'workspace_dir' | 'workspace_dev' | 'workspace_ino'> | undefined
    if (!row) throw new Error('Build not found.')
    return assertBuildWorkspaceIdentity({
      workspaceDir: row.workspace_dir,
      workspaceIdentity: row.workspace_dev !== null && row.workspace_ino !== null
        ? { dev: row.workspace_dev, ino: row.workspace_ino }
        : null,
    }, this.protectedRoots())
  }

  /** Consent and all revalidation stay in main; the callback only displays native UI. */
  async trustExistingBuild(id: string, confirm: (build: BuildRecord) => Promise<boolean>, assertIdle: () => void = () => {}): Promise<BuildRecord | null> {
    const build = this.getBuild(id)
    if (!build) throw new Error('Build not found.')
    if (build.playTrusted || build.executionTrusted) return build
    const capture = () => captureExistingBuildTrust(this.db, build, this.protectedRoots(), assertLegacyWorkspaceMatchesRegistry)
    assertIdle()
    const before = capture()
    if (!await confirm(build)) return null
    assertIdle()
    if (capture() !== before) throw new Error('The build, folder, or history changed while confirmation was open. Try again.')
    try {
      this.transaction(() => {
        this.assertBuildWorkspaceIdentity(id)
        this.db.prepare('UPDATE builds SET execution_trusted = 1, updated_at = ? WHERE id = ?').run(now(), id)
        const row = this.db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as unknown as BuildRow
        this.mirrorBuild(id, (folderDb) => putBuildRow(folderDb, row))
        this.appendEvent({ buildId: id, attemptId: null, ts: now(), kind: 'trust', channel: 'system',
          text: `Operator explicitly trusted this existing build and folder for Play and Resume with local user permissions: ${redactLogText(build.workspaceDir)}` })
      })
      this.assertBuildWorkspaceIdentity(id)
    } catch (error) {
      // A post-canonical mirror failure must not leave execution enabled.
      this.db.prepare('UPDATE builds SET execution_trusted = 0 WHERE id = ?').run(id)
      this.insertCanonicalEvent({ buildId: id, attemptId: null, ts: now(), kind: 'error', channel: 'error',
        text: 'Existing-build trust could not be persisted safely; execution trust was revoked. Retry after repairing the folder ledger.' })
      try { this.syncWorkspaceFolder(build.workspaceDir) } catch { /* canonical denial wins; existing repair event remains visible */ }
      throw error
    }
    return this.getBuild(id)!
  }

  latestBuild(): BuildRecord | null {
    const row = this.db.prepare('SELECT * FROM builds ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as BuildRow | undefined
    return row ? toBuild(row) : null
  }

  builds(): BuildRecord[] {
    const rows = this.db.prepare('SELECT * FROM builds ORDER BY created_at DESC, rowid DESC LIMIT ?').all(MAX_MATERIALIZED_BUILD_HISTORY + 1) as unknown as BuildRow[]
    if (rows.length > MAX_MATERIALIZED_BUILD_HISTORY) {
      throw new Error(`Full build history exceeds the administrative materialization limit of ${MAX_MATERIALIZED_BUILD_HISTORY}; use recentLoops() paging.`)
    }
    return rows.map(toBuild)
  }

  /**
   * Every project folder this app has ever run in. Executable resolution treats
   * these as agent-writable, so a binary planted in one is never spawned.
   */
  workspaceRoots(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT workspace_dir FROM builds').all() as unknown as Array<{ workspace_dir: string }>
    return rows.map((row) => row.workspace_dir).filter((dir) => typeof dir === 'string' && dir.length > 0)
  }

  buildsInWorkspace(workspaceDir: string): BuildRecord[] {
    let canonical = path.resolve(workspaceDir)
    try {
      canonical = fs.realpathSync(canonical)
    } catch {
      /* a missing workspace cannot match a registered executable root */
    }
    const rows = this.db.prepare('SELECT * FROM builds WHERE workspace_dir = ? ORDER BY created_at DESC').all(canonical) as unknown as BuildRow[]
    return rows.map(toBuild)
  }

  /**
   * Forget a build. Only the app registry is touched: the project folder keeps
   * its own `<build metadata dir>/ledger.db`, so `Import build` can bring it straight
   * back. Removing the files is a separate, explicit step.
   */
  deleteBuild(buildId: string): boolean {
    const workspaceDir = this.workspaceForBuild(buildId)
    if (!workspaceDir) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM events WHERE build_id = ?').run(buildId)
      this.db.prepare('DELETE FROM phase_attempts WHERE build_id = ?').run(buildId)
      this.db.prepare('DELETE FROM builds WHERE id = ?').run(buildId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    // Drop the cached handle so a later import re-reads the folder from disk.
    this.folderDbs.get(workspaceDir)?.db.close()
    this.folderDbs.delete(workspaceDir)
    return true
  }

  reports(): ReportRecord[] {
    const rows = this.db.prepare('SELECT data_json FROM reports ORDER BY created_at DESC, rowid DESC').all() as { data_json: string }[]
    return rows.map((row) => normalizeReportRecord(parseStoredJson(row.data_json, 'Persisted report')))
  }

  getReport(reportId: string): ReportRecord | null {
    const row = this.db.prepare('SELECT data_json FROM reports WHERE id = ?').get(reportId) as { data_json: string } | undefined
    return row ? normalizeReportRecord(parseStoredJson(row.data_json, 'Persisted report')) : null
  }

  saveReport(report: ReportRecord): ReportRecord {
    const normalized = normalizeReportRecord(report)
    this.db
      .prepare('INSERT OR REPLACE INTO reports (id, name, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(normalized.id, normalized.name, JSON.stringify(normalized), normalized.createdAt, normalized.updatedAt)
    return normalized
  }

  deleteReport(reportId: string): boolean {
    const before = this.db.prepare('SELECT id FROM reports WHERE id = ?').get(reportId)
    if (!before) return false
    this.db.prepare('DELETE FROM reports WHERE id = ?').run(reportId)
    return true
  }

  recentBuilds(limit: number, offset = 0): BuildRecord[] {
    const rows = this.db.prepare(
      `SELECT ${BUILD_LIST_PROJECTION_COLUMNS} FROM builds ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as unknown as BuildRow[]
    return rows.map(toBuild)
  }

  buildCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM builds').get() as { count: number }
    return Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : 0
  }

  runningBuild(): BuildRecord | null {
    const row = this.db.prepare("SELECT * FROM builds WHERE status = 'running' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as
      | BuildRow
      | undefined
    return row ? toBuild(row) : null
  }

  hasRunningActivity(): boolean {
    return this.db.prepare(
      `SELECT 1 FROM builds WHERE status = 'running'
       UNION ALL
       SELECT 1 FROM phase_attempts WHERE status = 'running'
       UNION ALL
       SELECT 1 FROM phase_attempts WHERE process_ownership_json IS NOT NULL
       LIMIT 1`,
    ).get() !== undefined
  }

  createAttempt(input: {
    buildId: string
    round: number
    role: PhaseRole
    harness: 'claude' | 'codex'
    prompt: string
  }): PhaseAttempt {
    if (this.transactionDepth === 0) return this.transaction(() => this.createAttempt(input))
    const id = crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO phase_attempts (id, build_id, round, role, harness, status, prompt, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(id, input.buildId, input.round, input.role, input.harness, redactLogText(input.prompt), now())
    const row = this.db.prepare('SELECT * FROM phase_attempts WHERE id = ?').get(id) as unknown as AttemptRow
    this.mirrorBuild(input.buildId, (folderDb) => putAttemptRow(folderDb, row))
    return this.getAttempt(id)!
  }

  patchAttempt(id: string, patch: AttemptPatch): void {
    if (this.transactionDepth === 0) return this.transaction(() => this.patchAttempt(id, patch))
    const sets: string[] = []
    const values: (string | number | null)[] = []
    const set = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`)
      values.push(value)
    }
    if (patch.status !== undefined) set('status', patch.status)
    if (patch.prompt !== undefined) {
      if (patch.prompt.length > 2 * 1024 * 1024) throw new Error('Build prompt exceeds the persisted prompt safety limit.')
      set('prompt', redactLogText(patch.prompt))
    }
    if (patch.model !== undefined) {
      const model = patch.model === null ? null : normalizePersistedModel(patch.model)
      if (patch.model !== null && model === null) throw new Error('Build model has an invalid identifier.')
      set('model', model)
    }
    if (patch.effort !== undefined) {
      if (patch.effort !== null && !EFFORTS.has(patch.effort)) throw new Error('Build effort is invalid.')
      set('effort', patch.effort)
    }
    if (patch.cliVersion !== undefined) set('cli_version', patchProvenance(patch.cliVersion, 'Build CLI version', 1_000))
    if (patch.priceTableVersion !== undefined) {
      if (patch.priceTableVersion !== null && !PRICE_TABLE_VERSION.test(patch.priceTableVersion)) throw new Error('Build price-table version is invalid.')
      set('price_table_version', patch.priceTableVersion)
    }
    if (patch.costSource !== undefined) set('cost_source', patchProvenance(patch.costSource, 'Build cost source', 256))
    if (patch.promptSha256 !== undefined) {
      if (patch.promptSha256 !== null && !SHA256.test(patch.promptSha256)) throw new Error('Build prompt hash is invalid.')
      set('prompt_sha256', patch.promptSha256)
    }
    if (patch.accountLabel !== undefined) set('account_label', patchProvenance(patch.accountLabel, 'Build account label', 256))
    if (patch.machineLabel !== undefined) set('machine_label', patchProvenance(patch.machineLabel, 'Build machine label', 256))
    if (patch.authMode !== undefined) {
      if (patch.authMode !== null && !AUTH_MODES.has(patch.authMode)) throw new Error('Build authentication mode is invalid.')
      set('auth_mode', patch.authMode)
    }
    if (patch.summary !== undefined) set('summary', patch.summary == null ? null : redactLogText(patch.summary))
    if (patch.verdict !== undefined) {
      const verdict = patch.verdict == null ? null : normalizeVerdict(patch.verdict)
      if (patch.verdict != null && !verdict) throw new Error('Build verdict does not match the persisted verdict contract.')
      set('verdict_json', verdict ? JSON.stringify(verdict) : null)
    }
    if (patch.metrics !== undefined) {
      const metrics = patch.metrics == null ? null : normalizeAttemptMetrics(patch.metrics)
      if (patch.metrics != null && !metrics) throw new Error('Build metrics do not match the persisted metrics contract.')
      set('metrics_json', metrics ? JSON.stringify(metrics) : null)
    }
    const boundedPatchNumber = (value: number | null, label: string, max: number, integer = false): number | null => {
      if (value === null) return null
      if (!Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))) {
        throw new Error(`${label} is outside its persisted safety range.`)
      }
      return value
    }
    if (patch.costUsd !== undefined) set('cost_usd', boundedPatchNumber(patch.costUsd, 'Build cost', MAX_ATTEMPT_COST_USD))
    if (patch.inputTokens !== undefined) set('input_tokens', boundedPatchNumber(patch.inputTokens, 'Build input tokens', MAX_ATTEMPT_TOKENS, true))
    if (patch.outputTokens !== undefined) set('output_tokens', boundedPatchNumber(patch.outputTokens, 'Build output tokens', MAX_ATTEMPT_TOKENS, true))
    if (patch.numTurns !== undefined) set('num_turns', boundedPatchNumber(patch.numTurns, 'Build turn count', MAX_ATTEMPT_TURNS, true))
    if (patch.durationMs !== undefined) set('duration_ms', boundedPatchNumber(patch.durationMs, 'Build duration', MAX_ATTEMPT_DURATION_MS, true))
    if (patch.sessionId !== undefined) {
      const sessionId = patch.sessionId === null ? null : normalizeSessionId(patch.sessionId)
      if (patch.sessionId !== null && sessionId === null) throw new Error('Build session id has an invalid format.')
      set('session_id', sessionId)
    }
    if (patch.revision !== undefined) set('revision', patch.revision)
    if (patch.error !== undefined) set('error', patch.error == null ? null : redactLogText(patch.error))
    if (patch.startedAt !== undefined) set('started_at', patch.startedAt)
    if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt)
    if (sets.length === 0) return
    this.db.prepare(`UPDATE phase_attempts SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    const row = this.db.prepare('SELECT * FROM phase_attempts WHERE id = ?').get(id) as AttemptRow | undefined
    if (row) {
      this.mirrorBuild(row.build_id, (folderDb) => putAttemptRow(folderDb, row))
    }
  }

  getAttempt(id: string): PhaseAttempt | null {
    const row = this.db.prepare('SELECT * FROM phase_attempts WHERE id = ?').get(id) as AttemptRow | undefined
    return row ? toAttempt(row) : null
  }

  setAttemptProcessOwnership(id: string, ownership: AttemptProcessOwnership): void {
    if (this.transactionDepth !== 0) throw new Error('Build process ownership must be committed outside a multi-row transaction.')
    const normalized = normalizeAttemptProcessOwnership(ownership)
    if (!normalized) throw new Error('Build process ownership is invalid.')
    if (!normalized.groupIdentities.includes(`${normalized.pid}:${normalized.processIdentity}`)) {
      throw new Error('Build process ownership does not include its exact leader identity.')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const target = this.db.prepare('SELECT process_ownership_json FROM phase_attempts WHERE id = ?').get(id) as
        | { process_ownership_json: string | null }
        | undefined
      if (!target) throw new Error('Build process ownership target was not found.')
      if (target.process_ownership_json !== null) throw new Error('Build already retains canonical process ownership.')
      const conflict = this.db.prepare(
        'SELECT id FROM phase_attempts WHERE process_ownership_json IS NOT NULL AND id <> ? LIMIT 1',
      ).get(id) as { id: string } | undefined
      if (conflict) throw new Error('Another attempt still retains canonical process ownership.')
      const updated = this.db.prepare('UPDATE phase_attempts SET process_ownership_json = ? WHERE id = ?').run(JSON.stringify(normalized), id)
      if (Number(updated.changes) !== 1) throw new Error('Build process ownership target was not found.')
      // Canonical commits first for this safety-critical field. A power loss
      // must never leave only the agent-writable portable mirror aware of a
      // live detached process.
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const row = this.db.prepare('SELECT * FROM phase_attempts WHERE id = ?').get(id) as AttemptRow | undefined
    if (row) this.mirrorSafetyCriticalAttemptRow(row)
  }

  /** Advance the retained group snapshot only across an exact member overlap. */
  updateAttemptProcessGroupIdentities(id: string, groupIdentities: readonly string[]): void {
    if (this.transactionDepth !== 0) throw new Error('Build process ownership must be committed outside a multi-row transaction.')
    const normalizedGroup = normalizeGroupIdentities(groupIdentities)
    if (!normalizedGroup) throw new Error('Build process group identities are invalid.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT process_ownership_json FROM phase_attempts WHERE id = ?').get(id) as
        | { process_ownership_json: string | null }
        | undefined
      let ownership: AttemptProcessOwnership | null = null
      try {
        ownership = row?.process_ownership_json
          ? normalizeAttemptProcessOwnership(JSON.parse(row.process_ownership_json) as unknown)
          : null
      } catch {
        ownership = null
      }
      if (!ownership) throw new Error('Build process ownership target is missing or invalid.')
      const previous = new Set(ownership.groupIdentities)
      if (!normalizedGroup.some((identity) => previous.has(identity))) {
        throw new Error('Build process group identity continuity could not be proven.')
      }
      const retainedGroup = [...ownership.groupIdentities]
      for (const identity of normalizedGroup) if (!previous.has(identity)) retainedGroup.push(identity)
      const advanced = normalizeAttemptProcessOwnership({ ...ownership, groupIdentities: retainedGroup })
      if (!advanced) throw new Error('Build process group identities exceed the canonical ownership safety limit.')
      this.db.prepare('UPDATE phase_attempts SET process_ownership_json = ? WHERE id = ?').run(JSON.stringify(advanced), id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const updated = this.db.prepare('SELECT * FROM phase_attempts WHERE id = ?').get(id) as AttemptRow | undefined
    if (updated) this.mirrorSafetyCriticalAttemptRow(updated)
  }

  attemptProcessOwnership(id: string): AttemptProcessOwnership | null {
    const row = this.db.prepare('SELECT process_ownership_json FROM phase_attempts WHERE id = ?').get(id) as
      | { process_ownership_json: string | null }
      | undefined
    if (!row?.process_ownership_json || Buffer.byteLength(row.process_ownership_json, 'utf8') > MAX_PROCESS_OWNERSHIP_BYTES) return null
    try {
      return normalizeAttemptProcessOwnership(JSON.parse(row.process_ownership_json) as unknown)
    } catch {
      return null
    }
  }

  /**
   * Return the globally retained detached-process claim without scanning attempt
   * history. The setter enforces a single claim; LIMIT 2 turns any invariant
   * violation into a fail-closed recovery error instead of an unbounded read.
   */
  attemptsWithProcessOwnership(): Array<{ attempt: PhaseAttempt; ownership: AttemptProcessOwnership }> {
    const rows = this.db.prepare(
      'SELECT * FROM phase_attempts WHERE process_ownership_json IS NOT NULL ORDER BY rowid ASC LIMIT 2',
    ).all() as unknown as AttemptRow[]
    if (rows.length > 1) throw new Error('Multiple attempts retain canonical process ownership; recovery stopped.')
    return rows.map((row) => {
      let ownership: AttemptProcessOwnership | null = null
      try {
        ownership = row.process_ownership_json && Buffer.byteLength(row.process_ownership_json, 'utf8') <= MAX_PROCESS_OWNERSHIP_BYTES
          ? normalizeAttemptProcessOwnership(JSON.parse(row.process_ownership_json) as unknown)
          : null
      } catch {
        ownership = null
      }
      if (!ownership) throw new Error('Canonical attempt process ownership is invalid; recovery stopped.')
      return { attempt: toAttempt(row), ownership }
    })
  }

  clearAttemptProcessOwnership(id: string): void {
    if (this.transactionDepth !== 0) throw new Error('Build process ownership must be committed outside a multi-row transaction.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const updated = this.db.prepare('UPDATE phase_attempts SET process_ownership_json = NULL WHERE id = ?').run(id)
      if (Number(updated.changes) !== 1) throw new Error('Build process ownership target was not found.')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const row = this.db.prepare('SELECT * FROM phase_attempts WHERE id = ?').get(id) as AttemptRow | undefined
    if (row) this.mirrorSafetyCriticalAttemptRow(row)
  }

  private mirrorSafetyCriticalAttemptRow(row: AttemptRow): void {
    try {
      const workspaceDir = this.workspaceForBuild(row.build_id)
      if (!workspaceDir) return
      putAttemptRow(this.openFolderDb(workspaceDir), row)
    } catch (error) {
      const message = `Portable process-ownership mirror update failed; canonical recovery state remains authoritative: ${redactLogText(error instanceof Error ? error.message : String(error)).slice(0, 3_000)}`
      this.db.prepare("INSERT INTO events (build_id, attempt_id, ts, kind, text, channel) VALUES (?, ?, ?, 'mirror-repair', ?, 'error')")
        .run(row.build_id, row.id, now(), message)
    }
  }

  attemptsForBuild(buildId: string): PhaseAttempt[] {
    const rows = this.db.prepare('SELECT * FROM phase_attempts WHERE build_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?').all(buildId, MAX_MATERIALIZED_ATTEMPT_HISTORY + 1) as unknown as AttemptRow[]
    if (rows.length > MAX_MATERIALIZED_ATTEMPT_HISTORY) {
      throw new Error(`Full build history exceeds the administrative materialization limit of ${MAX_MATERIALIZED_ATTEMPT_HISTORY}; use a paged or targeted query.`)
    }
    return rows.map(toAttempt)
  }

  recentAttemptProjectionForBuild(buildId: string, limit: number, offset = 0): { attempts: PhaseAttempt[]; truncatedFields: boolean } {
    const rows = this.db.prepare(
      `SELECT * FROM (
         SELECT ${ATTEMPT_PROJECTION_COLUMNS}, rowid AS _projection_rowid
         FROM phase_attempts
         WHERE build_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?
       ) ORDER BY created_at ASC, _projection_rowid ASC`,
    ).all(buildId, limit, offset) as unknown as AttemptProjectionRow[]
    return { attempts: rows.map(toAttempt), truncatedFields: rows.some((row) => row._projection_truncated === 1) }
  }

  recentAttemptProjectionForBuildByRole(buildId: string, role: PhaseRole, limit: number): { attempts: PhaseAttempt[]; truncatedFields: boolean } {
    const rows = this.db.prepare(
      `SELECT * FROM (
         SELECT ${ATTEMPT_PROJECTION_COLUMNS}, rowid AS _projection_rowid
         FROM phase_attempts
         WHERE build_id = ? AND role = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       ) ORDER BY created_at ASC, _projection_rowid ASC`,
    ).all(buildId, role, limit) as unknown as AttemptProjectionRow[]
    return { attempts: rows.map(toAttempt), truncatedFields: rows.some((row) => row._projection_truncated === 1) }
  }

  latestAttemptProjectionPerRound(buildId: string, role: PhaseRole, limit: number): { attempts: PhaseAttempt[]; truncatedFields: boolean } {
    const rows = this.db.prepare(
      `WITH ranked AS (
         SELECT ${ATTEMPT_PROJECTION_COLUMNS}, rowid AS _projection_rowid,
           ROW_NUMBER() OVER (PARTITION BY round ORDER BY created_at DESC, rowid DESC) AS _round_rank
         FROM phase_attempts WHERE build_id = ? AND role = ?
       )
       SELECT * FROM ranked WHERE _round_rank = 1 ORDER BY round ASC LIMIT ?`,
    ).all(buildId, role, limit) as unknown as AttemptProjectionRow[]
    return { attempts: rows.map(toAttempt), truncatedFields: rows.some((row) => row._projection_truncated === 1) }
  }

  attemptCountByRole(buildId: string, role: PhaseRole): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM phase_attempts WHERE build_id = ? AND role = ?').get(buildId, role) as { count: number }
    return Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : 0
  }

  hasAttemptRole(buildId: string, role: PhaseRole): boolean {
    return this.db.prepare('SELECT 1 FROM phase_attempts WHERE build_id = ? AND role = ? LIMIT 1').get(buildId, role) !== undefined
  }

  attemptAggregate(buildId: string): { costUsd: number; inputTokens: number; outputTokens: number; phaseAttemptCount: number } {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COUNT(CASE WHEN role != 'consult' THEN 1 END) AS phase_attempt_count
       FROM phase_attempts WHERE build_id = ?`,
    ).get(buildId) as { cost_usd: number; input_tokens: number; output_tokens: number; phase_attempt_count: number }
    if (!Number.isFinite(row.cost_usd) || row.cost_usd < 0 || !Number.isSafeInteger(row.input_tokens) || row.input_tokens < 0 || !Number.isSafeInteger(row.output_tokens) || row.output_tokens < 0) {
      throw new Error('Canonical attempt totals exceed their safe projection range.')
    }
    return { costUsd: row.cost_usd, inputTokens: row.input_tokens, outputTokens: row.output_tokens, phaseAttemptCount: row.phase_attempt_count }
  }

  attemptCount(buildId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM phase_attempts WHERE build_id = ?').get(buildId) as { count: number }
    return Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : 0
  }

  latestAttemptForBuild(buildId: string): PhaseAttempt | null {
    const row = this.db.prepare("SELECT * FROM phase_attempts WHERE build_id = ? AND role != 'consult' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(buildId) as AttemptRow | undefined
    return row ? toAttempt(row) : null
  }

  latestAttemptForBuildByRole(buildId: string, role: PhaseRole): PhaseAttempt | null {
    const row = this.db.prepare(
      'SELECT * FROM phase_attempts WHERE build_id = ? AND role = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).get(buildId, role) as AttemptRow | undefined
    return row ? toAttempt(row) : null
  }

  activeAttemptForBuild(buildId: string): PhaseAttempt | null {
    const rows = this.db.prepare(
      "SELECT * FROM phase_attempts WHERE build_id = ? AND role != 'consult' AND status = 'running' ORDER BY created_at DESC, rowid DESC LIMIT 2",
    ).all(buildId) as unknown as AttemptRow[]
    if (rows.length > 1) throw new Error('A build has multiple active attempts; recovery stopped.')
    return rows[0] ? toAttempt(rows[0]) : null
  }

  oldestQueuedAttemptForBuild(buildId: string): PhaseAttempt | null {
    const row = this.db.prepare(
      "SELECT * FROM phase_attempts WHERE build_id = ? AND role != 'consult' AND status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1",
    ).get(buildId) as AttemptRow | undefined
    return row ? toAttempt(row) : null
  }

  latestInterruptedAttemptForBuild(buildId: string): PhaseAttempt | null {
    const row = this.db.prepare(
      "SELECT * FROM phase_attempts WHERE build_id = ? AND role != 'consult' AND status = 'interrupted' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(buildId) as AttemptRow | undefined
    return row ? toAttempt(row) : null
  }

  firstSucceededAttemptIdForRole(buildId: string, role: PhaseRole): string | null {
    const row = this.db.prepare(
      "SELECT id FROM phase_attempts WHERE build_id = ? AND role = ? AND status = 'succeeded' ORDER BY created_at ASC, rowid ASC LIMIT 1",
    ).get(buildId, role) as { id: string } | undefined
    return row?.id ?? null
  }

  failedAttemptCount(buildId: string, role: PhaseRole, round: number): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM phase_attempts WHERE build_id = ? AND role = ? AND round = ? AND status = 'failed'",
    ).get(buildId, role, round) as { count: number }
    return Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : 0
  }

  rateLimitPauseCount(buildId: string, role: PhaseRole, round: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM phase_attempts
       WHERE build_id = ? AND role = ? AND round = ? AND status = 'interrupted'
         AND instr(lower(COALESCE(error, '')), 'retry scheduled for ') > 0`,
    ).get(buildId, role, round) as { count: number }
    return Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : 0
  }

  latestImplementSessionId(buildId: string, round: number, excludedAttemptId: string): string | null {
    const row = this.db.prepare(
      `SELECT session_id FROM phase_attempts
       WHERE build_id = ? AND role = 'implement' AND round = ? AND id <> ? AND session_id IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(buildId, round, excludedAttemptId) as { session_id: string } | undefined
    return normalizeSessionId(row?.session_id)
  }

  /** Bounded session candidates from strictly earlier implementations of this same build. */
  priorLeadImplementations(attemptId: string): Array<Pick<PhaseAttempt, 'id' | 'round' | 'harness' | 'model' | 'sessionId' | 'summary'>> {
    const rows = this.db.prepare(`SELECT id, round, harness, model, session_id, substr(summary, 1, 4000) AS summary FROM phase_attempts
      WHERE build_id = (SELECT build_id FROM phase_attempts WHERE id = ?) AND role = 'implement'
        AND rowid < (SELECT rowid FROM phase_attempts WHERE id = ?)
      ORDER BY rowid DESC LIMIT 1000`).all(attemptId, attemptId) as unknown as Array<{
        id: string; round: number; harness: PhaseAttempt['harness']; model: string | null; session_id: string | null; summary: string | null
      }>
    return rows.map(row => ({ id: row.id, round: row.round, harness: row.harness, model: row.model,
      sessionId: normalizeSessionId(row.session_id), summary: row.summary }))
  }

  /** Full structured memory, independent of the truncated activity-log projection. */
  leadEvents(buildId: string): BuildLogLine[] {
    const size = this.db.prepare("SELECT count(*) AS count, coalesce(sum(length(CAST(text AS BLOB))),0) AS bytes FROM events WHERE build_id=? AND kind LIKE 'lead-%'").get(buildId) as { count: number; bytes: number }
    if (size.count > 10000 || size.bytes > 8 * 1024 * 1024) throw new Error('Lead history exceeds its size limit.')
    const rows = this.db.prepare("SELECT * FROM events WHERE build_id=? AND kind LIKE 'lead-%' ORDER BY seq LIMIT 10000").all(buildId) as unknown as EventRow[]
    return rows.map(row => this.toLogLine(row, undefined))
  }

  previousImplementRevision(buildId: string, round: number): string | null {
    const row = this.db.prepare(
      `SELECT revision FROM phase_attempts
       WHERE build_id = ? AND role = 'implement' AND round < ? AND revision IS NOT NULL
       ORDER BY round DESC, created_at DESC, rowid DESC LIMIT 1`,
    ).get(buildId, round) as { revision: string } | undefined
    return row && REVISION.test(row.revision) ? row.revision : null
  }

  bestVerdictScore(buildId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(CAST(json_extract(verdict_json, '$.score') AS REAL)), 0) AS score
       FROM phase_attempts WHERE build_id = ? AND verdict_json IS NOT NULL`,
    ).get(buildId) as { score: number }
    return Number.isFinite(row.score) && row.score >= 0 && row.score <= 1 ? row.score : 0
  }

  eventTextForBuildWithPrefix(buildId: string, prefix: string): string | null {
    const row = this.db.prepare("SELECT substr(text, 1, 4096) AS text FROM events WHERE build_id = ? AND kind = 'artifact' AND substr(text, 1, ?) = ? ORDER BY seq LIMIT 1").get(buildId, prefix.length, prefix) as { text: string } | undefined
    return row?.text ?? null
  }

  eventTextForAttemptWithPrefix(attemptId: string, prefix: string): string | null {
    if (prefix.length === 0 || prefix.length > 1_024) throw new Error('Event prefix must be bounded.')
    const row = this.db.prepare(
      `SELECT substr(text, 1, 4096) AS text FROM events
       WHERE attempt_id = ? AND kind IN ('artifact', 'system') AND substr(text, 1, ?) = ?
       ORDER BY seq DESC LIMIT 1`,
    ).get(attemptId, prefix.length, prefix) as { text: string } | undefined
    return row?.text ? redactLogText(row.text) : null
  }

  latestAttemptIdForRole(buildId: string, role: PhaseRole): string | null {
    const row = this.db.prepare(
      'SELECT id FROM phase_attempts WHERE build_id = ? AND role = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).get(buildId, role) as { id: string } | undefined
    return row?.id ?? null
  }

  latestAttemptIdExcept(buildId: string, excludedAttemptId: string): string | null {
    const row = this.db.prepare(
      "SELECT id FROM phase_attempts WHERE build_id = ? AND id <> ? AND role != 'consult' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(buildId, excludedAttemptId) as { id: string } | undefined
    return row?.id ?? null
  }

  hasAttemptErrorPrefixForWorkspace(workspaceDir: string, prefix: string): boolean {
    if (prefix.length === 0 || prefix.length > 1_024) throw new Error('Build error prefix must be bounded.')
    return this.db.prepare(
      `SELECT 1
       FROM phase_attempts JOIN builds ON builds.id = phase_attempts.build_id
       WHERE builds.workspace_dir = ? AND substr(phase_attempts.error, 1, ?) = ?
       LIMIT 1`,
    ).get(workspaceDir, prefix.length, prefix) !== undefined
  }

  succeededImplementRevision(buildId: string, round: number): string | null {
    const row = this.db.prepare(
      `SELECT revision FROM phase_attempts
       WHERE build_id = ? AND role = 'implement' AND round = ? AND status = 'succeeded' AND revision IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(buildId, round) as { revision: string } | undefined
    return row && REVISION.test(row.revision) ? row.revision : null
  }

  promptAttemptForLog(attemptId: string): PromptLogAttempt | null {
    const row = this.db.prepare(
      `SELECT id, build_id, round, role, substr(prompt, 1, 524289) AS prompt,
              length(prompt) <= 524288 AS prompt_complete, created_at, started_at
       FROM phase_attempts WHERE id = ?`,
    ).get(attemptId) as {
      id: string; build_id: string; round: number; role: PhaseRole; prompt: string
      prompt_complete: number; created_at: string; started_at: string | null
    } | undefined
    return row ? {
      id: row.id, buildId: row.build_id, round: row.round, role: row.role,
      prompt: row.prompt, promptComplete: row.prompt_complete === 1,
      createdAt: row.created_at, startedAt: row.started_at,
    } : null
  }

  latestPromptAttemptForLog(buildId: string): PromptLogAttempt | null {
    const row = this.db.prepare('SELECT id FROM phase_attempts WHERE build_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(buildId) as { id: string } | undefined
    return row ? this.promptAttemptForLog(row.id) : null
  }

  attemptPrompt(buildId: string, role: PhaseRole, round: number): { attemptId: string; prompt: string } | null {
    const row = this.db.prepare(
      `SELECT id, prompt FROM phase_attempts
       WHERE build_id = ? AND role = ? AND round = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(buildId, role, round) as { id: string; prompt: string } | undefined
    return row ? { attemptId: row.id, prompt: row.prompt } : null
  }

  nextQueuedAttempt(buildId: string): PhaseAttempt | null {
    const row = this.db
      .prepare("SELECT * FROM phase_attempts WHERE build_id = ? AND role != 'consult' AND status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1")
      .get(buildId) as AttemptRow | undefined
    return row ? toAttempt(row) : null
  }

  private insertCanonicalEvent(line: BuildLogLine): EventRow {
    const row: EventRow = {
      seq: 0,
      build_id: line.buildId,
      attempt_id: line.attemptId,
      ts: line.ts,
      kind: line.kind,
      text: redactLogText(line.text),
      agent_id: line.agentId == null ? null : redactLogText(line.agentId).slice(0, 256),
      round: line.round ?? null,
      role: line.role ?? null,
      channel: line.channel ?? null,
    }
    this.db
      .prepare('INSERT INTO events (build_id, attempt_id, ts, kind, text, agent_id, round, role, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.build_id, row.attempt_id, row.ts, row.kind, row.text, row.agent_id, row.round, row.role, row.channel)
    return row
  }

  /**
   * Persist a control-plane event without touching the agent-writable mirror.
   * Use this only when a mirror/path failure is itself what must be recorded;
   * normal log evidence must continue through appendEvent and both ledgers.
   */
  appendCanonicalEvent(line: BuildLogLine): void {
    if (this.transactionDepth === 0) return this.transaction(() => this.appendCanonicalEvent(line))
    this.insertCanonicalEvent(line)
  }

  /** Stop a running attempt for app quit without depending on its workspace mirror. */
  cancelAttemptAndStopBuildCanonical(
    buildId: string,
    attemptId: string,
    reason: string,
    finishedAt: string,
    durationMs: number,
  ): void {
    this.stopAttemptAndBuildCanonical(buildId, attemptId, 'cancelled', reason, finishedAt, durationMs)
  }

  /** Quarantine a launched-but-unidentified attempt without touching its mirror. */
  interruptAttemptAndStopBuildCanonical(
    buildId: string,
    attemptId: string,
    reason: string,
    finishedAt: string,
    durationMs: number,
  ): void {
    this.stopAttemptAndBuildCanonical(buildId, attemptId, 'interrupted', reason, finishedAt, durationMs)
  }

  private stopAttemptAndBuildCanonical(
    buildId: string,
    attemptId: string,
    status: 'cancelled' | 'interrupted',
    reason: string,
    finishedAt: string,
    durationMs: number,
  ): void {
    if (this.transactionDepth !== 0) throw new Error('Canonical attempt termination requires its own transaction.')
    if (!isRecordId(buildId) || !isRecordId(attemptId)) throw new Error('Canonical attempt termination has an invalid record id.')
    if (!isIsoTimestamp(finishedAt)) throw new Error('Canonical attempt termination requires a canonical ISO timestamp.')
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > MAX_ATTEMPT_DURATION_MS) {
      throw new Error('Canonical attempt termination duration is outside its persisted safety range.')
    }
    const safeReason = redactLogText(reason).slice(0, 4_000)
    if (!safeReason) throw new Error('Canonical attempt termination requires a reason.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const attempt = this.db.prepare('SELECT round, role, status FROM phase_attempts WHERE id = ? AND build_id = ?').get(attemptId, buildId) as
        | { round: number; role: PhaseRole; status: AttemptStatus }
        | undefined
      if (!attempt) throw new Error('Canonical attempt termination target was not found.')
      if (attempt.status !== 'running') throw new Error('Canonical attempt termination target is not running.')
      const attemptUpdate = this.db.prepare(
        "UPDATE phase_attempts SET status = ?, error = ?, duration_ms = ?, finished_at = ? WHERE id = ? AND build_id = ? AND status = 'running'",
      ).run(status, safeReason, durationMs, finishedAt, attemptId, buildId)
      if (Number(attemptUpdate.changes) !== 1) throw new Error('Canonical attempt termination lost its running-attempt guard.')
      const buildUpdate = this.db.prepare(
        "UPDATE builds SET status = 'stopped', stop_reason = ?, updated_at = ? WHERE id = ?",
      ).run(safeReason, finishedAt, buildId)
      if (Number(buildUpdate.changes) !== 1) throw new Error('Canonical attempt termination could not find its build.')
      this.insertCanonicalEvent({
        buildId,
        attemptId,
        ts: finishedAt,
        kind: 'process-control',
        text: safeReason,
        round: attempt.round,
        role: attempt.role,
        channel: 'system',
      })
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* preserve the guarded cancellation error */
      }
      throw error
    }
  }

  appendEvent(line: BuildLogLine): void {
    if (this.transactionDepth === 0) return this.transaction(() => this.appendEvent(line))
    const row = this.insertCanonicalEvent(line)
    this.mirrorBuild(line.buildId, (folderDb) => putEventRow(folderDb, row, false))
  }

  /** Rows written before the schema grew derive channel from kind and round/role from their attempt. */
  private toLogLine(row: EventRow, attempt: { round: number; role: PhaseRole } | undefined): BuildLogLine {
    const line: BuildLogLine = {
      buildId: row.build_id,
      attemptId: row.attempt_id,
      ts: row.ts,
      kind: row.kind,
      text: redactLogText(row.text),
      channel: (row.channel as LogChannel | null) ?? channelForKind(row.kind),
    }
    if (row.agent_id) line.agentId = redactLogText(row.agent_id).slice(0, 256)
    const round = row.round ?? attempt?.round
    if (round != null) line.round = round
    const role = (row.role as PhaseRole | null) ?? attempt?.role
    if (role != null) line.role = role
    return line
  }

  private attemptStamp(attemptId: string): { buildId: string; round: number; role: PhaseRole } | null {
    const row = this.db.prepare('SELECT build_id, round, role FROM phase_attempts WHERE id = ?').get(attemptId) as
      | { build_id: string; round: number; role: string }
      | undefined
    return row && PHASE_ROLES.has(row.role as PhaseRole)
      ? { buildId: row.build_id, round: row.round, role: row.role as PhaseRole }
      : null
  }

  eventsForAttempt(attemptId: string, kind?: string, limit = 500): BuildLogLine[] {
    const rows = (
      kind
        ? this.db.prepare(`SELECT ${EVENT_PROJECTION_COLUMNS} FROM events WHERE attempt_id = ? AND kind = ? ORDER BY seq DESC LIMIT ?`).all(attemptId, kind, limit)
        : this.db.prepare(`SELECT ${EVENT_PROJECTION_COLUMNS} FROM events WHERE attempt_id = ? ORDER BY seq DESC LIMIT ?`).all(attemptId, limit)
    ) as unknown as EventProjectionRow[]
    let attempt: { buildId: string; round: number; role: PhaseRole } | null | undefined
    return rows.reverse().map((row) => {
      if (row.round == null || row.role == null) attempt ??= this.attemptStamp(attemptId)
      return this.toLogLine(row, attempt ?? undefined)
    })
  }

  eventsForBuild(buildId: string, limit = 800): BuildLogLine[] {
    const candidates = this.db.prepare(
      `SELECT ${EVENT_PROJECTION_COLUMNS} FROM events WHERE build_id = ? ORDER BY seq DESC LIMIT ?`,
    ).all(buildId, limit) as unknown as EventProjectionRow[]
    const rows: EventProjectionRow[] = []
    let remainingBytes = 2 * 1024 * 1024
    let projectionTruncated = false
    for (const row of candidates) {
      const size = Buffer.byteLength(row.text, 'utf8') + 512
      if (size > remainingBytes) {
        projectionTruncated = true
        break
      }
      remainingBytes -= size
      projectionTruncated ||= row._projection_truncated === 1
      rows.push(row)
    }
    let attemptsById: Map<string, { buildId: string; round: number; role: PhaseRole }> | null = null
    const projected = rows.reverse().map((row) => {
      let attempt: { buildId: string; round: number; role: PhaseRole } | undefined
      if (row.attempt_id && (row.round == null || row.role == null)) {
        attemptsById ??= new Map()
        attempt = attemptsById.get(row.attempt_id)
        if (!attempt) {
          const candidate = this.attemptStamp(row.attempt_id)
          if (candidate?.buildId === buildId) {
            attemptsById.set(row.attempt_id, candidate)
            attempt = candidate
          }
        }
      }
      return this.toLogLine(row, attempt)
    })
    if (projectionTruncated) {
      projected.unshift({
        buildId,
        attemptId: null,
        ts: projected[0]?.ts ?? now(),
        kind: 'system',
        channel: 'system',
        text: 'Earlier or oversized log entries were omitted from this bounded view; the canonical ledger and raw streams retain the complete evidence.',
      })
    }
    return projected
  }

  runningBuilds(): BuildRecord[] {
    const rows = this.db.prepare("SELECT * FROM builds WHERE status = 'running' LIMIT ?").all(MAX_RUNNING_BUILD_RECOVERY + 1) as unknown as BuildRow[]
    if (rows.length > MAX_RUNNING_BUILD_RECOVERY) {
      throw new Error(`Running-build recovery exceeds its safety limit of ${MAX_RUNNING_BUILD_RECOVERY}; manual intervention is required.`)
    }
    return rows.map(toBuild)
  }

  /** Flush the complete project history into the SQLite ledger stored in its folder. */
  prepareBuildFolder(buildId: string): string {
    const workspaceDir = this.workspaceForBuild(buildId)
    if (!workspaceDir) throw new Error('Build not found.')
    this.syncWorkspaceFolder(workspaceDir)
    const folderDb = this.folderDbs.get(workspaceDir)
    folderDb?.db.close()
    this.folderDbs.delete(workspaceDir)
    if (folderDb) {
      const stat = fs.lstatSync(folderDb.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== folderDb.dev || stat.ino !== folderDb.ino) {
        throw new Error('Portable ledger was replaced while preparing the export snapshot.')
      }
    }
    return workspaceDir
  }

  /** Register every build from a transferred folder without changing its IDs or history. */
  importBuildFolder(workspaceDir: string): BuildSnapshot[] {
    const capturedWorkspace = captureWorkspaceIdentity(workspaceDir, this.protectedRoots())
    workspaceDir = capturedWorkspace.workspaceDir
    migrateBuildMetadataDir(workspaceDir)
    const snapshot = snapshotBuildLedger(workspaceDir)
    try {

    // Validate the supplied database before trusting it. The only mutation is
    // the pre-rename table migration, applied to this private temp copy after
    // validation passes. Path rebinding happens only after every row and
    // relationship has passed.
    const portable = new DatabaseSync(snapshot.ledgerPath)
    let importedRows: ImportedRows
    try {
      importedRows = readImportedRows(portable)
    } finally {
      portable.close()
    }

    // Import must never take ownership away from a live local process. A
    // detached child can outlive a rewritten attempt row, so reject the whole
    // physical workspace while either its build or one of its attempts is live.
    const activeWorkspace = this.db.prepare(
      `SELECT builds.id
       FROM builds
       LEFT JOIN phase_attempts ON phase_attempts.build_id = builds.id
         AND (phase_attempts.status = 'running' OR phase_attempts.process_ownership_json IS NOT NULL)
       WHERE builds.workspace_dir = ? AND (builds.status = 'running' OR phase_attempts.id IS NOT NULL)
       LIMIT 1`,
    ).get(workspaceDir) as { id: string } | undefined
    if (activeWorkspace) throw new Error('Cannot import a workspace while one of its local builds is active.')
    if (this.hasAttemptErrorPrefixForWorkspace(workspaceDir, 'Launch identity was not durably recorded before the app exited.')) {
      throw new Error('Cannot import a workspace quarantined after unknown process ownership; confirm and clear the external process before using a separate project copy.')
    }

    // Re-importing the same physical project is an idempotent resync. A UUID
    // already registered to any other workspace is a collision, not consent
    // to delete and replace that project's history.
    for (const build of importedRows.builds) {
      const existing = this.db.prepare('SELECT workspace_dir, status, play_trusted, execution_trusted FROM builds WHERE id = ?').get(build.id) as
        | { workspace_dir: string; status: string; play_trusted: number; execution_trusted: number }
        | undefined
      if (existing && canonicalizePath(existing.workspace_dir) !== workspaceDir) {
        throw new Error(`Imported build ${build.id} collides with history owned by another workspace.`)
      }
      if (existing?.status === 'running') throw new Error(`Cannot import build ${build.id} while its local build is active.`)
      // A trusted local registry is authoritative. Its agent-writable portable
      // mirror must never be able to replace executable prompts, revisions, or
      // private-home session identifiers under the registry's trust decision.
      if (existing?.play_trusted === 1 || existing?.execution_trusted === 1) {
        throw new Error(`Build ${build.id} is already registered as trusted local history; no import is needed.`)
      }
      for (const attempt of importedRows.attemptsByBuild.get(build.id) ?? []) {
        const existingAttempt = this.db
          .prepare('SELECT phase_attempts.build_id, builds.workspace_dir FROM phase_attempts JOIN builds ON builds.id = phase_attempts.build_id WHERE phase_attempts.id = ?')
          .get(attempt.id) as { build_id: string; workspace_dir: string } | undefined
        if (
          existingAttempt &&
          (existingAttempt.build_id !== build.id || canonicalizePath(existingAttempt.workspace_dir) !== workspaceDir)
        ) {
          throw new Error(`Imported build ${attempt.id} collides with history owned by another build or workspace.`)
        }
      }
    }

    // Do not hold our cached mirror connection while migrating that database.
    const cachedMirror = this.folderDbs.get(workspaceDir)
    cachedMirror?.db.close()
    this.folderDbs.delete(workspaceDir)

    const priorRows: Array<{ build: BuildRow | undefined; attempts: AttemptRow[]; events: EventRow[] }> = []
    const priorAttempts = this.db.prepare('SELECT * FROM phase_attempts WHERE build_id = ? ORDER BY created_at ASC, rowid ASC')
    const priorEvents = this.db.prepare('SELECT * FROM events WHERE build_id = ? ORDER BY seq ASC')
    for (const build of importedRows.builds) {
      const attempts: AttemptRow[] = []
      for (const attempt of priorAttempts.iterate(build.id) as unknown as Iterable<AttemptRow>) attempts.push(attempt)
      const events: EventRow[] = []
      for (const event of priorEvents.iterate(build.id) as unknown as Iterable<EventRow>) events.push(event)
      priorRows.push({
        build: this.db.prepare('SELECT * FROM builds WHERE id = ?').get(build.id) as unknown as BuildRow | undefined,
        attempts,
        events,
      })
    }
    const imported: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const build of importedRows.builds) {
        const wasRunning = build.status === 'running'
        const safeBuild: BuildRow = {
          ...build,
          workspace_dir: workspaceDir,
          workspace_dev: capturedWorkspace.workspaceIdentity.dev,
          workspace_ino: capturedWorkspace.workspaceIdentity.ino,
          status: wasRunning ? 'stopped' : build.status,
          stop_reason: wasRunning ? 'Imported in-flight build was stopped for safety.' : build.stop_reason,
          // First-time and idempotently refreshed transferred histories are
          // untrusted. Trusted local histories are rejected above.
          play_trusted: 0,
          execution_trusted: 0,
        }
        const attempts = importedRows.attemptsByBuild.get(build.id)!.map((attempt): AttemptRow => {
          if (attempt.status !== 'running' && attempt.status !== 'queued') return attempt
          return {
            ...attempt,
            status: 'interrupted',
            error: attempt.error ?? 'Imported in-flight attempt was interrupted for safety.',
          }
        })
        const events = importedRows.eventsByBuild.get(build.id)!

        this.db.prepare('DELETE FROM events WHERE build_id = ?').run(build.id)
        this.db.prepare('DELETE FROM phase_attempts WHERE build_id = ?').run(build.id)
        putBuildRow(this.db, safeBuild)
        for (const attempt of attempts) putAttemptRow(this.db, attempt)
        // The registry assigns local sequence numbers because it may contain
        // unrelated projects; the canonical mirror rewrite below restores a
        // complete per-workspace sequence after registry commit.
        for (const event of events) putEventRow(this.db, event, false)
        imported.push(build.id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    // Never commit the portable database before the canonical registry. If
    // power fails here, the registry row exists and startup repair deterministically
    // rebuilds the stale mirror; there is no unregistered mutated source.
    try {
      this.publishWorkspaceFolderAtomically(workspaceDir, snapshot.sourceIdentities)
    } catch (error) {
      // Runtime mirror failures are compensated to the exact prior registry
      // state. Abrupt power loss cannot run this branch, but canonical-first
      // ordering leaves registered rows for startup repair instead.
      const cached = this.folderDbs.get(workspaceDir)
      try {
        cached?.db.close()
      } catch {
        /* preserve the mirror error */
      }
      this.folderDbs.delete(workspaceDir)
      this.db.exec('BEGIN IMMEDIATE')
      try {
        for (const build of importedRows.builds) {
          this.db.prepare('DELETE FROM events WHERE build_id = ?').run(build.id)
          this.db.prepare('DELETE FROM phase_attempts WHERE build_id = ?').run(build.id)
          this.db.prepare('DELETE FROM builds WHERE id = ?').run(build.id)
        }
        for (const prior of priorRows) {
          if (!prior.build) continue
          putBuildRow(this.db, prior.build)
          for (const attempt of prior.attempts) putAttemptRow(this.db, attempt)
          for (const event of prior.events) putEventRow(this.db, event, true)
        }
        this.db.exec('COMMIT')
      } catch {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          /* compensation itself could not complete */
        }
      }
      try {
        restoreBuildLedgerSnapshot(snapshot, workspaceDir)
      } catch (restoreError) {
        const primary = error instanceof Error ? error.message : String(error)
        const rollback = restoreError instanceof Error ? restoreError.message : String(restoreError)
        throw new Error(`Import failed (${primary}) and the selected portable ledger could not be restored (${rollback}).`)
      }
      throw error
    }

    return imported
      .map((id) => {
        const build = this.getBuild(id)!
        const count = this.attemptCount(id)
        const projection = this.recentAttemptProjectionForBuild(id, 200)
        return { build, attempts: projection.attempts, totalAttempts: count, hasMoreAttempts: count > 200 || projection.truncatedFields }
      })
      .sort((a, b) => compareText(b.build.createdAt, a.build.createdAt) || compareText(b.build.id, a.build.id))
      .slice(0, 1)
    } finally {
      snapshot.cleanup()
    }
  }

  /**
   * Fail closed for a pre-boundary registry row without touching its unsafe
   * portable mirror or process metadata. Returns false if the path is safe.
   */
  quarantineUnsafeWorkspace(buildId: string, reason: string): boolean {
    const build = this.getBuild(buildId)
    if (!build) return false
    try {
      this.assertBuildWorkspaceIdentity(buildId)
      return false
    } catch {
      const timestamp = now()
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.prepare("UPDATE phase_attempts SET status = 'interrupted', error = ?, finished_at = COALESCE(finished_at, ?) WHERE build_id = ? AND status IN ('running', 'queued')")
          .run(redactLogText(reason), timestamp, buildId)
        this.db.prepare("UPDATE builds SET status = 'stopped', stop_reason = ?, updated_at = ? WHERE id = ?")
          .run(redactLogText(reason), timestamp, buildId)
        this.db.prepare("INSERT INTO events (build_id, attempt_id, ts, kind, text, channel) VALUES (?, NULL, ?, 'workspace-boundary', ?, 'error')")
          .run(buildId, timestamp, redactLogText(reason).slice(0, 4_000))
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      return true
    }
  }

  /**
   * Mark an orphaned in-flight attempt interrupted and queue a fresh attempt with
   * the same prompt (implement attempts get the resume marker so the runner
   * continues the prior claude session instead of restarting the round).
   */
  requeueInterruptedAttempt(attempt: PhaseAttempt): PhaseAttempt {
    return this.transaction(() => {
      this.patchAttempt(attempt.id, {
        status: 'interrupted',
        error: 'App restarted mid-build; a fresh attempt was queued.',
        finishedAt: now(),
      })
      const replacement = this.createAttempt({
        buildId: attempt.buildId,
        round: attempt.round,
        role: attempt.role,
        harness: attempt.harness,
        prompt: attempt.role === 'implement' ? markResumePrompt(attempt.prompt) : attempt.prompt,
      })
      if (!attempt.revision) return replacement
      this.patchAttempt(replacement.id, { revision: attempt.revision })
      return this.getAttempt(replacement.id)!
    })
  }

  steeringEvents(buildId: string): BuildLogLine[] {
    const size = this.db.prepare("SELECT count(*) AS count, coalesce(sum(length(CAST(text AS BLOB))),0) AS bytes FROM events WHERE build_id=? AND kind LIKE 'steering-%'").get(buildId) as { count: number; bytes: number }
    if (size.count > 10000 || size.bytes > 8 * 1024 * 1024) throw new Error('Steering history exceeds its size limit.')
    const rows = this.db.prepare("SELECT * FROM events WHERE build_id=? AND kind LIKE 'steering-%' ORDER BY seq LIMIT 10000").all(buildId) as unknown as EventRow[]
    return rows.map(row => this.toLogLine(row, undefined))
  }

  unfinishedConsults(): PhaseAttempt[] {
    const rows = this.db.prepare("SELECT * FROM phase_attempts WHERE role='consult' AND status IN ('queued','running') LIMIT 101").all() as unknown as AttemptRow[]
    if (rows.length > 100) throw new Error('Too many unfinished steering chats; manual intervention is required.')
    return rows.map(toAttempt)
  }

  close(): void {
    for (const folderDb of this.folderDbs.values()) folderDb.db.close()
    this.folderDbs.clear()
    this.db.close()
  }
}
