import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  LoopLogLine,
  LoopModels,
  LoopRecord,
  LoopStatus,
  RunMetrics,
  RunRecord,
  RunRole,
  RunStatus,
  Verdict,
} from '../shared/loop'
import { RESUME_PREFIX } from '../shared/loop'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS loops (
  id TEXT PRIMARY KEY,
  title TEXT,
  prompt TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  max_rounds INTEGER NOT NULL,
  budget_usd REAL,
  models_json TEXT NOT NULL,
  status TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  stop_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  loop_id TEXT NOT NULL REFERENCES loops(id),
  round INTEGER NOT NULL,
  role TEXT NOT NULL,
  harness TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  summary TEXT,
  verdict_json TEXT,
  metrics_json TEXT,
  cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  num_turns INTEGER,
  duration_ms INTEGER,
  session_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  loop_id TEXT NOT NULL,
  run_id TEXT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_loop ON runs(loop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_loop ON events(loop_id, seq);
`

function now(): string {
  return new Date().toISOString()
}

interface LoopRow {
  id: string
  title: string | null
  prompt: string
  workspace_dir: string
  max_rounds: number
  budget_usd: number | null
  models_json: string
  status: string
  round: number
  total_cost_usd: number
  stop_reason: string | null
  created_at: string
  updated_at: string
}

interface RunRow {
  id: string
  loop_id: string
  round: number
  role: string
  harness: string
  status: string
  prompt: string
  model: string | null
  summary: string | null
  verdict_json: string | null
  metrics_json: string | null
  cost_usd: number | null
  input_tokens: number | null
  output_tokens: number | null
  num_turns: number | null
  duration_ms: number | null
  session_id: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export function defaultLoopTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  const quoted = compact.match(/["“]([^"”]{1,80})["”]/)?.[1]
  const unquoted = compact
    .replace(/^(?:please\s+)?(?:build|create|make|develop|implement)\s+/i, '')
    .split(/\s+[—–]\s+|:\s+/)[0]
  const candidate = (quoted ?? unquoted).replace(/[.!?]+$/, '').trim().slice(0, 56) || 'Untitled run'
  const normalized = candidate.replace(/-([A-Z])([a-z]+)/g, (_match, initial: string, rest: string) => `-${initial.toLowerCase()}${rest}`)
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function toLoop(row: LoopRow): LoopRecord {
  return {
    id: row.id,
    title: row.title || defaultLoopTitle(row.prompt),
    prompt: row.prompt,
    workspaceDir: row.workspace_dir,
    maxRounds: row.max_rounds,
    budgetUsd: row.budget_usd,
    models: JSON.parse(row.models_json) as LoopModels,
    status: row.status as LoopStatus,
    round: row.round,
    totalCostUsd: row.total_cost_usd,
    stopReason: row.stop_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    loopId: row.loop_id,
    round: row.round,
    role: row.role as RunRole,
    harness: row.harness as 'claude' | 'codex',
    status: row.status as RunStatus,
    prompt: row.prompt,
    model: row.model,
    summary: row.summary,
    verdict: row.verdict_json ? (JSON.parse(row.verdict_json) as Verdict) : null,
    metrics: row.metrics_json ? (JSON.parse(row.metrics_json) as RunMetrics) : null,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    numTurns: row.num_turns,
    durationMs: row.duration_ms,
    sessionId: row.session_id,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export interface RunPatch {
  status?: RunStatus
  model?: string | null
  summary?: string | null
  verdict?: Verdict | null
  metrics?: RunMetrics | null
  costUsd?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  numTurns?: number | null
  durationMs?: number | null
  sessionId?: string | null
  error?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export interface LoopPatch {
  title?: string
  status?: LoopStatus
  round?: number
  totalCostUsd?: number
  stopReason?: string | null
}

export class Ledger {
  private db: DatabaseSync

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    const loopColumns = this.db.prepare('PRAGMA table_info(loops)').all() as unknown as { name: string }[]
    if (!loopColumns.some((column) => column.name === 'title')) this.db.exec('ALTER TABLE loops ADD COLUMN title TEXT;')
  }

  createLoop(input: {
    prompt: string
    workspaceDir: string
    maxRounds: number
    budgetUsd: number | null
    models: LoopModels
  }): LoopRecord {
    const id = crypto.randomUUID()
    const ts = now()
    this.db
      .prepare(
        `INSERT INTO loops (id, title, prompt, workspace_dir, max_rounds, budget_usd, models_json, status, round, total_cost_usd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 1, 0, ?, ?)`,
      )
      .run(id, defaultLoopTitle(input.prompt), input.prompt, input.workspaceDir, input.maxRounds, input.budgetUsd, JSON.stringify(input.models), ts, ts)
    return this.getLoop(id)!
  }

  patchLoop(id: string, patch: LoopPatch): void {
    const sets: string[] = ['updated_at = ?']
    const values: (string | number | null)[] = [now()]
    if (patch.title !== undefined) (sets.push('title = ?'), values.push(patch.title))
    if (patch.status !== undefined) (sets.push('status = ?'), values.push(patch.status))
    if (patch.round !== undefined) (sets.push('round = ?'), values.push(patch.round))
    if (patch.totalCostUsd !== undefined) (sets.push('total_cost_usd = ?'), values.push(patch.totalCostUsd))
    if (patch.stopReason !== undefined) (sets.push('stop_reason = ?'), values.push(patch.stopReason))
    this.db.prepare(`UPDATE loops SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  }

  getLoop(id: string): LoopRecord | null {
    const row = this.db.prepare('SELECT * FROM loops WHERE id = ?').get(id) as LoopRow | undefined
    return row ? toLoop(row) : null
  }

  latestLoop(): LoopRecord | null {
    const row = this.db.prepare('SELECT * FROM loops ORDER BY created_at DESC LIMIT 1').get() as LoopRow | undefined
    return row ? toLoop(row) : null
  }

  loops(): LoopRecord[] {
    const rows = this.db.prepare('SELECT * FROM loops ORDER BY created_at DESC, rowid DESC').all() as unknown as LoopRow[]
    return rows.map(toLoop)
  }

  runningLoop(): LoopRecord | null {
    const row = this.db.prepare("SELECT * FROM loops WHERE status = 'running' ORDER BY created_at DESC LIMIT 1").get() as
      | LoopRow
      | undefined
    return row ? toLoop(row) : null
  }

  createRun(input: {
    loopId: string
    round: number
    role: RunRole
    harness: 'claude' | 'codex'
    prompt: string
  }): RunRecord {
    const id = crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO runs (id, loop_id, round, role, harness, status, prompt, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(id, input.loopId, input.round, input.role, input.harness, input.prompt, now())
    return this.getRun(id)!
  }

  patchRun(id: string, patch: RunPatch): void {
    const sets: string[] = []
    const values: (string | number | null)[] = []
    const set = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`)
      values.push(value)
    }
    if (patch.status !== undefined) set('status', patch.status)
    if (patch.model !== undefined) set('model', patch.model)
    if (patch.summary !== undefined) set('summary', patch.summary)
    if (patch.verdict !== undefined) set('verdict_json', patch.verdict ? JSON.stringify(patch.verdict) : null)
    if (patch.metrics !== undefined) set('metrics_json', patch.metrics ? JSON.stringify(patch.metrics) : null)
    if (patch.costUsd !== undefined) set('cost_usd', patch.costUsd)
    if (patch.inputTokens !== undefined) set('input_tokens', patch.inputTokens)
    if (patch.outputTokens !== undefined) set('output_tokens', patch.outputTokens)
    if (patch.numTurns !== undefined) set('num_turns', patch.numTurns)
    if (patch.durationMs !== undefined) set('duration_ms', patch.durationMs)
    if (patch.sessionId !== undefined) set('session_id', patch.sessionId)
    if (patch.error !== undefined) set('error', patch.error)
    if (patch.startedAt !== undefined) set('started_at', patch.startedAt)
    if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt)
    if (sets.length === 0) return
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
    return row ? toRun(row) : null
  }

  runsForLoop(loopId: string): RunRecord[] {
    const rows = this.db.prepare('SELECT * FROM runs WHERE loop_id = ? ORDER BY created_at ASC').all(loopId) as unknown as RunRow[]
    return rows.map(toRun)
  }

  nextQueuedRun(loopId: string): RunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE loop_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1")
      .get(loopId) as RunRow | undefined
    return row ? toRun(row) : null
  }

  appendEvent(line: LoopLogLine): void {
    this.db
      .prepare('INSERT INTO events (loop_id, run_id, ts, kind, text) VALUES (?, ?, ?, ?, ?)')
      .run(line.loopId, line.runId, line.ts, line.kind, line.text)
  }

  eventsForRun(runId: string, kind?: string, limit = 500): LoopLogLine[] {
    const rows = (
      kind
        ? this.db.prepare('SELECT loop_id, run_id, ts, kind, text FROM events WHERE run_id = ? AND kind = ? ORDER BY seq ASC LIMIT ?').all(runId, kind, limit)
        : this.db.prepare('SELECT loop_id, run_id, ts, kind, text FROM events WHERE run_id = ? ORDER BY seq ASC LIMIT ?').all(runId, limit)
    ) as { loop_id: string; run_id: string | null; ts: string; kind: string; text: string }[]
    return rows.map((row) => ({ loopId: row.loop_id, runId: row.run_id, ts: row.ts, kind: row.kind, text: row.text }))
  }

  eventsForLoop(loopId: string, limit = 800): LoopLogLine[] {
    const rows = this.db
      .prepare('SELECT loop_id, run_id, ts, kind, text FROM events WHERE loop_id = ? ORDER BY seq DESC LIMIT ?')
      .all(loopId, limit) as { loop_id: string; run_id: string | null; ts: string; kind: string; text: string }[]
    return rows.reverse().map((row) => ({ loopId: row.loop_id, runId: row.run_id, ts: row.ts, kind: row.kind, text: row.text }))
  }

  runningLoops(): LoopRecord[] {
    const rows = this.db.prepare("SELECT * FROM loops WHERE status = 'running'").all() as unknown as LoopRow[]
    return rows.map(toLoop)
  }

  /**
   * Mark an orphaned in-flight run interrupted and queue a fresh attempt with
   * the same prompt (implement attempts get the resume marker so the runner
   * continues the prior claude session instead of restarting the round).
   */
  requeueInterruptedRun(run: RunRecord): RunRecord {
    this.patchRun(run.id, {
      status: 'interrupted',
      error: 'App restarted mid-run; a fresh attempt was queued.',
      finishedAt: now(),
    })
    const basePrompt = run.prompt.startsWith(RESUME_PREFIX) ? run.prompt.slice(RESUME_PREFIX.length) : run.prompt
    return this.createRun({
      loopId: run.loopId,
      round: run.round,
      role: run.role,
      harness: run.harness,
      prompt: run.role === 'implement' ? RESUME_PREFIX + basePrompt : basePrompt,
    })
  }

  close(): void {
    this.db.close()
  }
}
