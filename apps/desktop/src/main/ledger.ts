import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  LoopLogLine,
  LoopModels,
  LoopRecord,
  LoopSnapshot,
  LoopStatus,
  RunMetrics,
  RunRecord,
  RunRole,
  RunStatus,
  Verdict,
} from '../shared/loop'
import { normalizeModels } from '../shared/models'
import { RESUME_PREFIX } from '../shared/loop'
import { assertRunFolder, runLedgerPath } from './run-transfer'

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
  revision TEXT,
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
  revision: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

interface EventRow {
  seq: number
  loop_id: string
  run_id: string | null
  ts: string
  kind: string
  text: string
}

function initializeSchema(db: DatabaseSync, journalMode: 'WAL' | 'DELETE'): void {
  db.exec(`PRAGMA journal_mode = ${journalMode};`)
  db.exec(SCHEMA)
  const loopColumns = db.prepare('PRAGMA table_info(loops)').all() as unknown as { name: string }[]
  if (!loopColumns.some((column) => column.name === 'title')) db.exec('ALTER TABLE loops ADD COLUMN title TEXT;')
  const runColumns = db.prepare('PRAGMA table_info(runs)').all() as unknown as { name: string }[]
  if (!runColumns.some((column) => column.name === 'revision')) db.exec('ALTER TABLE runs ADD COLUMN revision TEXT;')
}

function putLoopRow(db: DatabaseSync, row: LoopRow, workspaceDir = row.workspace_dir): void {
  db.prepare(
    `INSERT OR REPLACE INTO loops
      (id, title, prompt, workspace_dir, max_rounds, budget_usd, models_json, status, round, total_cost_usd, stop_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.title,
    row.prompt,
    workspaceDir,
    row.max_rounds,
    row.budget_usd,
    row.models_json,
    row.status,
    row.round,
    row.total_cost_usd,
    row.stop_reason,
    row.created_at,
    row.updated_at,
  )
}

function putRunRow(db: DatabaseSync, row: RunRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO runs
      (id, loop_id, round, role, harness, status, prompt, model, summary, verdict_json, metrics_json, cost_usd,
       input_tokens, output_tokens, num_turns, duration_ms, session_id, revision, error, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.loop_id,
    row.round,
    row.role,
    row.harness,
    row.status,
    row.prompt,
    row.model,
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
    db.prepare('INSERT OR REPLACE INTO events (seq, loop_id, run_id, ts, kind, text) VALUES (?, ?, ?, ?, ?, ?)').run(
      row.seq,
      row.loop_id,
      row.run_id,
      row.ts,
      row.kind,
      row.text,
    )
    return
  }
  db.prepare('INSERT INTO events (loop_id, run_id, ts, kind, text) VALUES (?, ?, ?, ?, ?)').run(
    row.loop_id,
    row.run_id,
    row.ts,
    row.kind,
    row.text,
  )
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
    models: normalizeModels(JSON.parse(row.models_json) as Partial<LoopModels>),
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
    revision: row.revision,
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
  revision?: string | null
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
  private folderDbs = new Map<string, DatabaseSync>()

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    initializeSchema(this.db, 'WAL')
  }

  private openFolderDb(workspaceDir: string): DatabaseSync {
    const existing = this.folderDbs.get(workspaceDir)
    if (existing) return existing
    const dbPath = runLedgerPath(workspaceDir)
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    initializeSchema(db, 'DELETE')
    this.folderDbs.set(workspaceDir, db)
    return db
  }

  private workspaceForLoop(loopId: string): string | null {
    const row = this.db.prepare('SELECT workspace_dir FROM loops WHERE id = ?').get(loopId) as { workspace_dir: string } | undefined
    return row?.workspace_dir ?? null
  }

  private ensureFolderDbForLoop(loopId: string): DatabaseSync | null {
    const workspaceDir = this.workspaceForLoop(loopId)
    if (!workspaceDir) return null
    const existed = fs.existsSync(runLedgerPath(workspaceDir))
    const db = this.openFolderDb(workspaceDir)
    if (!existed) this.syncWorkspaceFolder(workspaceDir)
    return db
  }

  private syncWorkspaceFolder(workspaceDir: string): void {
    const folderDb = this.openFolderDb(workspaceDir)
    const loops = this.db.prepare('SELECT * FROM loops WHERE workspace_dir = ? ORDER BY created_at ASC').all(workspaceDir) as unknown as LoopRow[]
    folderDb.exec('BEGIN IMMEDIATE')
    try {
      folderDb.exec('DELETE FROM events; DELETE FROM runs; DELETE FROM loops;')
      for (const loop of loops) {
        putLoopRow(folderDb, loop)
        const runs = this.db.prepare('SELECT * FROM runs WHERE loop_id = ? ORDER BY created_at ASC').all(loop.id) as unknown as RunRow[]
        for (const run of runs) putRunRow(folderDb, run)
        const events = this.db.prepare('SELECT * FROM events WHERE loop_id = ? ORDER BY seq ASC').all(loop.id) as unknown as EventRow[]
        for (const event of events) putEventRow(folderDb, event, true)
      }
      folderDb.exec('COMMIT')
    } catch (error) {
      folderDb.exec('ROLLBACK')
      throw error
    }
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
    this.syncWorkspaceFolder(input.workspaceDir)
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
    const row = this.db.prepare('SELECT * FROM loops WHERE id = ?').get(id) as LoopRow | undefined
    const folderDb = this.ensureFolderDbForLoop(id)
    if (row && folderDb) putLoopRow(folderDb, row)
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
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow
    const folderDb = this.ensureFolderDbForLoop(input.loopId)
    if (folderDb) putRunRow(folderDb, row)
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
    if (patch.revision !== undefined) set('revision', patch.revision)
    if (patch.error !== undefined) set('error', patch.error)
    if (patch.startedAt !== undefined) set('started_at', patch.startedAt)
    if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt)
    if (sets.length === 0) return
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
    if (row) {
      const folderDb = this.ensureFolderDbForLoop(row.loop_id)
      if (folderDb) putRunRow(folderDb, row)
    }
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
    const folderDb = this.ensureFolderDbForLoop(line.loopId)
    if (folderDb) {
      putEventRow(
        folderDb,
        {
          seq: 0,
          loop_id: line.loopId,
          run_id: line.runId,
          ts: line.ts,
          kind: line.kind,
          text: line.text,
        },
        false,
      )
    }
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

  /** Flush the complete project history into the SQLite ledger stored in its folder. */
  prepareRunFolder(loopId: string): string {
    const workspaceDir = this.workspaceForLoop(loopId)
    if (!workspaceDir) throw new Error('Run not found.')
    if (!fs.existsSync(runLedgerPath(workspaceDir))) this.syncWorkspaceFolder(workspaceDir)
    const folderDb = this.folderDbs.get(workspaceDir)
    folderDb?.close()
    this.folderDbs.delete(workspaceDir)
    return workspaceDir
  }

  /** Register every run from a transferred folder without changing its IDs or history. */
  importRunFolder(workspaceDir: string): LoopSnapshot[] {
    const folderPath = assertRunFolder(workspaceDir)
    const source = new DatabaseSync(folderPath)
    initializeSchema(source, 'DELETE')
    const loops = source.prepare('SELECT * FROM loops ORDER BY created_at DESC').all() as unknown as LoopRow[]
    if (loops.length === 0) {
      source.close()
      throw new Error('The folder ledger does not contain any runs.')
    }

    const imported: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    source.exec('BEGIN IMMEDIATE')
    try {
      for (const loop of loops) {
        // Decode typed JSON now so malformed ledgers fail before registration.
        toLoop({ ...loop, workspace_dir: workspaceDir })
        const runs = source.prepare('SELECT * FROM runs WHERE loop_id = ? ORDER BY created_at ASC').all(loop.id) as unknown as RunRow[]
        const events = source.prepare('SELECT * FROM events WHERE loop_id = ? ORDER BY seq ASC').all(loop.id) as unknown as EventRow[]
        for (const run of runs) toRun(run)

        this.db.prepare('DELETE FROM events WHERE loop_id = ?').run(loop.id)
        this.db.prepare('DELETE FROM runs WHERE loop_id = ?').run(loop.id)
        putLoopRow(this.db, loop, workspaceDir)
        for (const run of runs) putRunRow(this.db, run)
        // The folder keeps its exact event sequence. The app registry assigns
        // local sequence numbers because it may contain unrelated projects.
        for (const event of events) putEventRow(this.db, event, false)
        source.prepare('UPDATE loops SET workspace_dir = ? WHERE id = ?').run(workspaceDir, loop.id)
        imported.push(loop.id)
      }
      this.db.exec('COMMIT')
      source.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      source.exec('ROLLBACK')
      source.close()
      throw error
    }
    source.close()

    const oldMirror = this.folderDbs.get(workspaceDir)
    oldMirror?.close()
    this.folderDbs.delete(workspaceDir)
    return imported
      .map((id) => {
        const loop = this.getLoop(id)!
        return { loop, runs: this.runsForLoop(id) }
      })
      .sort((a, b) => b.loop.createdAt.localeCompare(a.loop.createdAt))
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
    for (const folderDb of this.folderDbs.values()) folderDb.close()
    this.folderDbs.clear()
    this.db.close()
  }
}
