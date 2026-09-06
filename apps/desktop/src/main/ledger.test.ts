import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { defaultBuildTitle, Ledger, MAX_MATERIALIZED_ATTEMPT_HISTORY, MAX_OPEN_FOLDER_DATABASES } from './ledger'

const models = resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'claude-opus-5', subagentEffort: 'medium' }, DEFAULT_CRITIC)

let dir: string | null = null

function makeLedger(): Ledger {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-ledger-'))
  return new Ledger(path.join(dir, 'ledger.db'))
}

function workspace(name = 'workspace'): string {
  if (!dir) throw new Error('Test ledger has not been created.')
  const workspaceDir = path.join(dir, name)
  fs.mkdirSync(workspaceDir, { recursive: true })
  return workspaceDir
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

/** A ledger written before the Build rename: `builds`, `builds`, and their columns. */
function seedPreRenameLedger(dbPath: string, workspaceDir: string, buildId: string, attemptId: string): void {
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE loops (
      id TEXT PRIMARY KEY, title TEXT, prompt TEXT NOT NULL, workspace_dir TEXT NOT NULL,
      workspace_dev INTEGER, workspace_ino INTEGER, max_rounds INTEGER NOT NULL, budget_usd REAL,
      models_json TEXT NOT NULL, status TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0, stop_reason TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, play_trusted INTEGER NOT NULL DEFAULT 0,
      execution_trusted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, loop_id TEXT NOT NULL REFERENCES loops(id), round INTEGER NOT NULL,
      role TEXT NOT NULL, harness TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL,
      model TEXT, effort TEXT, cli_version TEXT, price_table_version TEXT, cost_source TEXT,
      prompt_sha256 TEXT, account_label TEXT, machine_label TEXT, auth_mode TEXT,
      process_ownership_json TEXT, summary TEXT, verdict_json TEXT, metrics_json TEXT,
      cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, num_turns INTEGER,
      duration_ms INTEGER, session_id TEXT, revision TEXT, error TEXT, created_at TEXT NOT NULL,
      started_at TEXT, finished_at TEXT
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, loop_id TEXT NOT NULL, run_id TEXT, ts TEXT NOT NULL,
      kind TEXT NOT NULL, text TEXT NOT NULL, agent_id TEXT, round INTEGER, role TEXT, channel TEXT
    );
    CREATE INDEX idx_runs_loop ON runs(loop_id, created_at);
    CREATE INDEX idx_events_loop ON events(loop_id, seq);
  `)
  legacy.prepare(
    `INSERT INTO loops
     (id, prompt, workspace_dir, max_rounds, budget_usd, models_json, status, round, total_cost_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(buildId, 'old prompt', workspaceDir, 2, null, JSON.stringify(models), 'stopped', 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  legacy.prepare(
    `INSERT INTO runs (id, loop_id, round, role, harness, status, prompt, process_ownership_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(attemptId, buildId, 1, 'implement', 'claude', 'succeeded', 'old build', '{"pid":4242}', '2026-01-01T00:00:00.000Z')
  legacy.prepare(
    `INSERT INTO events (loop_id, run_id, ts, kind, text) VALUES (?, ?, ?, ?, ?)`,
  ).run(buildId, attemptId, '2026-01-01T00:00:00.000Z', 'system', 'carried across the rename')
  legacy.close()
}

describe('Ledger', () => {
  it('bounds inactive portable-ledger handles without evicting an active mirror transaction', () => {
    const ledger = makeLedger()
    const internal = ledger as unknown as {
      folderDbs: Map<string, { db: DatabaseSync }>
      openFolderDb(workspaceDir: string): DatabaseSync
    }
    let oldest: DatabaseSync | null = null
    for (let index = 0; index < MAX_OPEN_FOLDER_DATABASES; index += 1) {
      const workspaceDir = workspace(`cache-${index}`)
      ledger.createBuild({ prompt: `build ${index}`, workspaceDir, maxRounds: 1, budgetUsd: null, models })
      if (index === 0) oldest = internal.folderDbs.get(fs.realpathSync(workspaceDir))!.db
    }
    ledger.transaction(() => {
      internal.openFolderDb(workspace('cache-extra'))
      expect(internal.folderDbs.size).toBe(MAX_OPEN_FOLDER_DATABASES + 1)
      expect(() => oldest!.prepare('SELECT 1')).not.toThrow()
    })

    expect(internal.folderDbs.size).toBe(MAX_OPEN_FOLDER_DATABASES)
    expect(() => oldest!.prepare('SELECT 1')).toThrow(/not open/)
    ledger.close()
  })

  it('fails visibly when retained no-clobber mirror recoveries reach their storage cap', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace('recovery-cap')
    const build = ledger.createBuild({ prompt: 'bounded recovery', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const metadataDir = path.join(workspaceDir, '.gauntlet-gamesmith')
    for (let index = 0; index < 64; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      fs.writeFileSync(path.join(metadataDir, `.ledger.${id}.ledger.db.recovery`), 'retained')
    }

    const internal = ledger as unknown as { publishWorkspaceFolderAtomically(workspaceDir: string): void }
    expect(() => internal.publishWorkspaceFolderAtomically(workspaceDir)).toThrow(/recovery storage reached its safety limit.*manually remove/)
    expect(fs.readdirSync(metadataDir).filter((name) => name.endsWith('.recovery'))).toHaveLength(64)
    ledger.close()
  })

  it('derives concise, tasteful build titles from prompts', () => {
    expect(defaultBuildTitle('Build "Pac-Claude" — a modern AAA game')).toBe('Pac-claude')
    expect(defaultBuildTitle('Create a polished authentication flow: include passkeys')).toBe('A polished authentication flow')
  })

  it('detects running build or attempt activity without materializing history', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'activity', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    expect(ledger.hasRunningActivity()).toBe(true)
    ledger.patchBuild(build.id, { status: 'stopped' })
    expect(ledger.hasRunningActivity()).toBe(false)
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'codex', prompt: 'go' })
    ledger.patchAttempt(attempt.id, { status: 'running' })
    expect(ledger.hasRunningActivity()).toBe(true)
    ledger.patchAttempt(attempt.id, { status: 'interrupted' })
    expect(ledger.hasRunningActivity()).toBe(false)
    const other = ledger.createBuild({ prompt: 'other id, same workspace', workspaceDir: build.workspaceDir, maxRounds: 1, budgetUsd: null, models })
    expect(other.id).not.toBe(build.id)
    expect(ledger.hasRunningActivity()).toBe(true)
    ledger.patchBuild(other.id, { status: 'stopped' })
    expect(ledger.hasRunningActivity()).toBe(false)
    ledger.close()
  })

  it('answers lifecycle lookups with bounded scalar or single-row queries', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'targeted lookups', workspaceDir: workspace(), maxRounds: 3, budgetUsd: null, models })
    const reference = ledger.createAttempt({ buildId: build.id, round: 0, role: 'reference', harness: 'claude', prompt: 'study' })
    ledger.patchAttempt(reference.id, { status: 'succeeded' })
    ledger.appendEvent({
      buildId: build.id,
      attemptId: reference.id,
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'artifact',
      text: `Reference Pack frozen at sha256:${'a'.repeat(64)}`,
    })
    const first = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'codex', prompt: 'first' })
    ledger.patchAttempt(first.id, { status: 'failed', sessionId: 'thread-1', revision: 'b'.repeat(40) })
    const pause = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'codex', prompt: 'pause' })
    ledger.patchAttempt(pause.id, { status: 'interrupted', error: 'retry scheduled for 2026-01-01T00:01:00.000Z' })
    const queued = ledger.createAttempt({ buildId: build.id, round: 2, role: 'implement', harness: 'codex', prompt: 'queued' })
    const active = ledger.createAttempt({ buildId: build.id, round: 2, role: 'critique', harness: 'claude', prompt: 'active' })
    ledger.patchAttempt(active.id, {
      status: 'running',
      verdict: { score: 0.75, pass: false, summary: 'close', findings: [] },
    })

    expect(ledger.hasAttemptRole(build.id, 'reference')).toBe(true)
    expect(ledger.firstSucceededAttemptIdForRole(build.id, 'reference')).toBe(reference.id)
    expect(ledger.eventTextForAttemptWithPrefix(reference.id, 'Reference Pack frozen at sha256:')).toContain('a'.repeat(64))
    expect(ledger.failedAttemptCount(build.id, 'implement', 1)).toBe(1)
    expect(ledger.rateLimitPauseCount(build.id, 'implement', 1)).toBe(1)
    expect(ledger.latestInterruptedAttemptForBuild(build.id)?.id).toBe(pause.id)
    expect(ledger.oldestQueuedAttemptForBuild(build.id)?.id).toBe(queued.id)
    expect(ledger.activeAttemptForBuild(build.id)?.id).toBe(active.id)
    expect(ledger.latestImplementSessionId(build.id, 1, pause.id)).toBe('thread-1')
    expect(ledger.previousImplementRevision(build.id, 2)).toBe('b'.repeat(40))
    expect(ledger.bestVerdictScore(build.id)).toBe(0.75)
    ledger.close()
  })

  it('records a redacted canonical control event when the workspace mirror is unavailable', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace('canonical-event')
    const build = ledger.createBuild({ prompt: 'control plane', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const displaced = `${workspaceDir}-displaced`
    fs.renameSync(workspaceDir, displaced)
    const secret = `ghp_${'a'.repeat(36)}`

    expect(() => ledger.appendCanonicalEvent({
      buildId: build.id,
      attemptId: null,
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'process-control',
      channel: 'error',
      text: `Could not verify process ${secret}`,
    })).not.toThrow()
    expect(ledger.eventsForBuild(build.id).at(-1)?.text).toBe('Could not verify process [REDACTED]')
    ledger.close()
  })

  it('atomically cancels a running build and stops its build without touching an unsafe mirror', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace('canonical-quit')
    const build = ledger.createBuild({ prompt: 'quit safely', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'work' })
    ledger.patchAttempt(attempt.id, { status: 'running' })
    const displaced = `${workspaceDir}-displaced`
    fs.renameSync(workspaceDir, displaced)
    const finishedAt = '2026-01-01T00:00:01.000Z'

    ledger.cancelAttemptAndStopBuildCanonical(build.id, attempt.id, 'Stopped safely for quit.', finishedAt, 1_000)

    expect(ledger.getAttempt(attempt.id)).toMatchObject({ status: 'cancelled', error: 'Stopped safely for quit.', durationMs: 1_000, finishedAt })
    expect(ledger.getBuild(build.id)).toMatchObject({ status: 'stopped', stopReason: 'Stopped safely for quit.' })
    expect(ledger.eventsForBuild(build.id).at(-1)).toMatchObject({ attemptId: attempt.id, kind: 'process-control', text: 'Stopped safely for quit.' })
    expect(() => ledger.cancelAttemptAndStopBuildCanonical(build.id, attempt.id, 'again', finishedAt, 1_000)).toThrow(/not running/)
    ledger.close()
  })

  it('refuses to materialize an unbounded full build history', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'bounded history', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    const internal = ledger as unknown as { db: DatabaseSync }
    internal.db.prepare(
      `WITH RECURSIVE sequence(n) AS (
         VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
       )
       INSERT INTO phase_attempts (id, build_id, round, role, harness, status, prompt, created_at)
       SELECT printf('00000000-0000-4000-8000-%012d', n), ?, 1, 'implement', 'claude', 'succeeded', 'bounded', '2026-01-01T00:00:00.000Z'
       FROM sequence`,
    ).run(MAX_MATERIALIZED_ATTEMPT_HISTORY + 1, build.id)

    expect(() => ledger.attemptsForBuild(build.id)).toThrow(/administrative materialization limit/)
    expect(ledger.attemptCount(build.id)).toBe(MAX_MATERIALIZED_ATTEMPT_HISTORY + 1)
    ledger.close()
  })

  it('round-trips builds, builds, verdicts and metrics', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'build it', workspaceDir: workspace(), maxRounds: 5, budgetUsd: 50, models })
    expect(build.status).toBe('running')
    expect(build.round).toBe(0)
    expect(build.title).toBe('It')
    expect(build.playTrusted).toBe(true)
    expect(build.workspaceIdentity).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) })
    expect(ledger.assertBuildWorkspaceIdentity(build.id)).toBe(build.workspaceDir)
    expect(build.models.criticModel).toBe('gpt-5.6-sol')

    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'p1' })
    expect(ledger.nextQueuedAttempt(build.id)!.id).toBe(attempt.id)

    ledger.patchAttempt(attempt.id, {
      status: 'succeeded',
      revision: '0123456789abcdef0123456789abcdef01234567',
      effort: 'high',
      cliVersion: 'claude 9.9.9',
      priceTableVersion: '2026-09-02',
      costSource: 'stream total',
      promptSha256: 'a'.repeat(64),
      accountLabel: 'claude:app-managed-profile',
      machineLabel: 'test-machine',
      authMode: 'subscription',
      costUsd: 4.2,
      verdict: { score: 0.4, pass: false, summary: 's', findings: [{ severity: 'major', text: 'f' }] },
      metrics: { agents: [{ id: 'orchestrator', label: 'orchestrator', model: 'claude-fable-5', messages: 3, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, firstTs: null, lastTs: null }], perModel: {} },
    })
    const saved = ledger.getAttempt(attempt.id)!
    expect(saved.status).toBe('succeeded')
    expect(saved.revision).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(saved).toMatchObject({
      effort: 'high',
      cliVersion: 'claude 9.9.9',
      priceTableVersion: '2026-09-02',
      costSource: 'stream total',
      promptSha256: 'a'.repeat(64),
      accountLabel: 'claude:app-managed-profile',
      machineLabel: 'test-machine',
      authMode: 'subscription',
    })
    expect(saved.verdict!.findings[0].text).toBe('f')
    expect(saved.metrics!.agents[0].messages).toBe(3)
    expect(ledger.nextQueuedAttempt(build.id)).toBeNull()

    ledger.patchBuild(build.id, { status: 'passed', totalCostUsd: 4.2, stopReason: 'done' })
    expect(ledger.latestBuild()!.status).toBe('passed')
    expect(ledger.runningBuild()).toBeNull()
    ledger.close()
  })

  it('persists an operator-supplied build title', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'Build a game', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    ledger.patchBuild(build.id, { title: 'Arcade study' })

    expect(ledger.getBuild(build.id)?.title).toBe('Arcade study')
    ledger.close()
  })

  it('gives repeated prompts distinct prompt-derived build names', () => {
    const ledger = makeLedger()
    const first = ledger.createBuild({ prompt: 'Build a neon Pac-Man game', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    ledger.patchBuild(first.id, { status: 'stopped' })
    const second = ledger.createBuild({ prompt: 'Build a neon Pac-Man game', workspaceDir: workspace('second'), maxRounds: 1, budgetUsd: null, models })

    expect(first.title).toBe('A neon Pac-man game')
    expect(second.title).toBe('A neon Pac-man game (2)')
    ledger.close()
  })

  it('appends and reads back events in order', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    for (let i = 0; i < 5; i += 1) ledger.appendEvent({ buildId: build.id, attemptId: null, ts: `t${i}`, kind: 'system', text: `line ${i}` })
    const lines = ledger.eventsForBuild(build.id, 3)
    expect(lines.map((l) => l.text)).toEqual(['line 2', 'line 3', 'line 4'])
    ledger.close()
  })

  it('truncates event text in SQL before renderer projection', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    ledger.appendEvent({ buildId: build.id, attemptId: null, ts: '2026-01-01T00:00:00.000Z', kind: 'system', text: 'x'.repeat(100_000) })
    const lines = ledger.eventsForBuild(build.id)
    expect(lines[0].text).toMatch(/oversized log entries were omitted/)
    const line = lines[1]
    expect(line.text.length).toBeLessThan(4_100)
    expect(line.text).toMatch(/projection truncated/)
    ledger.close()
  })

  it('redacts credential-shaped log text before either ledger persists it', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const secret = `ghp_${'a'.repeat(36)}`
    const agentSecret = `sk-proj-${'f'.repeat(24)}`
    ledger.appendEvent({
      buildId: build.id,
      attemptId: null,
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'system',
      text: `tool output ${secret}\nAWS_SECRET_ACCESS_KEY=aws-secret\nCookie: session=browser-secret`,
      agentId: agentSecret,
    })

    expect(ledger.eventsForBuild(build.id)[0].text).toBe('tool output [REDACTED]\nAWS_SECRET_ACCESS_KEY=[REDACTED]\nCookie: [REDACTED]')
    expect(ledger.eventsForBuild(build.id)[0].agentId).toBe('[REDACTED]')
    const folder = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(folder.prepare('SELECT text, agent_id FROM events').get()).toEqual({
      text: 'tool output [REDACTED]\nAWS_SECRET_ACCESS_KEY=[REDACTED]\nCookie: [REDACTED]',
      agent_id: '[REDACTED]',
    })
    folder.close()
    ledger.close()
  })

  it('lists every build with the newest prompt first', () => {
    const ledger = makeLedger()
    const first = ledger.createBuild({ prompt: 'first', workspaceDir: workspace('one'), maxRounds: 1, budgetUsd: null, models })
    const second = ledger.createBuild({ prompt: 'second', workspaceDir: workspace('two'), maxRounds: 1, budgetUsd: null, models })

    expect(ledger.builds().map((build) => build.id)).toEqual([second.id, first.id])
    ledger.close()
  })

  it('requeues an orphaned build with the resume marker', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir: workspace(), maxRounds: 3, budgetUsd: null, models })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 2, role: 'implement', harness: 'claude', prompt: 'build it' })
    const revision = '0123456789abcdef0123456789abcdef01234567'
    ledger.patchAttempt(attempt.id, { status: 'running', revision })

    const requeued = ledger.requeueInterruptedAttempt(ledger.getAttempt(attempt.id)!)
    expect(ledger.getAttempt(attempt.id)!.status).toBe('interrupted')
    expect(ledger.getBuild(build.id)!.status).toBe('running')
    expect(requeued.round).toBe(2)
    expect(requeued.status).toBe('queued')
    expect(requeued.prompt).toBe('[[gauntlet:resume]]\nbuild it')
    expect(requeued.revision).toBe(revision)
    // Requeuing the requeued attempt must not stack markers.
    const again = ledger.requeueInterruptedAttempt(requeued)
    expect(again.prompt).toBe('[[gauntlet:resume]]\nbuild it')
    expect(ledger.runningBuilds().map((l) => l.id)).toEqual([build.id])
    ledger.close()
  })

  it('migrates every missing column independently from the previous schema', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-ledger-legacy-'))
    const dbPath = path.join(dir, 'ledger.db')
    const workspaceDir = fs.realpathSync(workspace())
    const buildId = '11111111-1111-4111-8111-111111111111'
    const attemptId = '22222222-2222-4222-8222-222222222222'
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      CREATE TABLE loops (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, workspace_dir TEXT NOT NULL,
        max_rounds INTEGER NOT NULL, budget_usd REAL, models_json TEXT NOT NULL,
        status TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0, stop_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, loop_id TEXT NOT NULL, round INTEGER NOT NULL, role TEXT NOT NULL,
        harness TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT, summary TEXT,
        verdict_json TEXT, metrics_json TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
        num_turns INTEGER, duration_ms INTEGER, session_id TEXT, error TEXT, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, loop_id TEXT NOT NULL, run_id TEXT, ts TEXT NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL, agent_id TEXT
      );
    `)
    legacy.prepare(
      `INSERT INTO loops
       (id, prompt, workspace_dir, max_rounds, budget_usd, models_json, status, round, total_cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(buildId, 'old prompt', workspaceDir, 2, null, JSON.stringify(models), 'stopped', 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    legacy.prepare(
      `INSERT INTO runs
       (id, loop_id, round, role, harness, status, prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(attemptId, buildId, 1, 'assets', 'claude', 'succeeded', 'old build', '2026-01-01 00:00:00')
    legacy.close()
    const legacyMetadataDir = path.join(workspaceDir, '.gauntlet-loop')
    const metadataDir = path.join(workspaceDir, '.gauntlet-gamesmith')
    fs.mkdirSync(legacyMetadataDir)
    fs.copyFileSync(dbPath, path.join(legacyMetadataDir, 'ledger.db'))

    const ledger = new Ledger(dbPath)
    // The matching portable history proves which existing canonical folder
    // receives the compatibility identity. Play remains explicitly untrusted.
    expect(ledger.eventsForBuild(buildId).filter((event) => event.kind === 'workspace-identity')).toEqual([])
    expect(ledger.getBuild(buildId)).toMatchObject({
      title: 'Old prompt',
      playTrusted: false,
      workspaceIdentity: { dev: expect.any(Number), ino: expect.any(Number) },
    })
    expect(ledger.assertBuildWorkspaceIdentity(buildId)).toBe(fs.realpathSync(workspaceDir))
    expect(fs.existsSync(legacyMetadataDir)).toBe(false)
    expect(fs.existsSync(path.join(metadataDir, 'ledger.db'))).toBe(true)
    expect(ledger.getAttempt(attemptId)).toMatchObject({
      revision: null,
      effort: null,
      cliVersion: null,
      priceTableVersion: null,
      costSource: null,
      promptSha256: null,
      accountLabel: null,
      machineLabel: null,
      authMode: null,
    })
    ledger.close()

    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    const columns = (table: string): string[] =>
      (migrated.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((column) => column.name)
    expect(columns("builds")).toEqual(expect.arrayContaining(['title', 'play_trusted', 'workspace_dev', 'workspace_ino']))
    expect(columns("phase_attempts")).toEqual(
      expect.arrayContaining([
        'revision',
        'effort',
        'cli_version',
        'price_table_version',
        'cost_source',
        'prompt_sha256',
        'account_label',
        'machine_label',
        'auth_mode',
      ]),
    )
    expect(columns('events')).toEqual(expect.arrayContaining(['agent_id', 'round', 'role', 'channel']))
    const adopted = migrated.prepare('SELECT workspace_dev, workspace_ino FROM builds WHERE id = ?').get(buildId)
    migrated.close()

    const portable = new DatabaseSync(path.join(metadataDir, 'ledger.db'), { readOnly: true })
    expect(portable.prepare('SELECT workspace_dev, workspace_ino FROM builds WHERE id = ?').get(buildId)).toEqual(adopted)
    portable.close()

    const reopened = new Ledger(dbPath)
    expect(reopened.getBuild(buildId)?.workspaceIdentity).toEqual({
      dev: (adopted as { workspace_dev: number }).workspace_dev,
      ino: (adopted as { workspace_ino: number }).workspace_ino,
    })
    reopened.close()
  })

  it('renames the pre-Build vocabulary once, keeps every row, and backs the file up first', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-ledger-rename-'))
    const dbPath = path.join(dir, 'ledger.db')
    const buildId = '33333333-3333-4333-8333-333333333333'
    const attemptId = '44444444-4444-4444-8444-444444444444'
    seedPreRenameLedger(dbPath, fs.realpathSync(workspace()), buildId, attemptId)

    const ledger = new Ledger(dbPath)
    expect(ledger.getBuild(buildId)?.prompt).toBe('old prompt')
    expect(ledger.getAttempt(attemptId)?.role).toBe('implement')
    // Later entries are this fixture's missing portable mirror, not the rename.
    expect(ledger.eventsForBuild(buildId)[0]?.text).toBe('carried across the rename')
    ledger.close()

    // The pre-migration copy is the only undo, so it must exist and still read.
    const backupPath = `${dbPath}.pre-build-rename`
    expect(fs.existsSync(backupPath)).toBe(true)
    const backup = new DatabaseSync(backupPath, { readOnly: true })
    expect(backup.prepare('SELECT id FROM runs').get()).toEqual({ id: attemptId })
    backup.close()

    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    const tables = (migrated.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as unknown as { name: string }[])
      .map((table) => table.name)
    expect(tables).toEqual(expect.arrayContaining(['builds', 'phase_attempts']))
    expect(tables).not.toContain('loops')
    expect(tables).not.toContain('runs')
    const indexes = (migrated.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all() as unknown as { name: string }[])
      .map((index) => index.name)
    expect(indexes.sort()).toEqual(['idx_attempts_build', 'idx_events_build'])
    expect(migrated.prepare('SELECT build_id FROM phase_attempts WHERE id = ?').get(attemptId)).toEqual({ build_id: buildId })
    // Recovery reads process ownership off this column; the rename must not lose it.
    expect(migrated.prepare('SELECT process_ownership_json FROM phase_attempts WHERE id = ?').get(attemptId))
      .toEqual({ process_ownership_json: '{"pid":4242}' })
    expect(migrated.prepare('SELECT build_id, attempt_id FROM events').get()).toEqual({ build_id: buildId, attempt_id: attemptId })
    migrated.close()

    // Reopening must be a no-op: no second migration, no second backup.
    const reopened = new Ledger(dbPath)
    expect(reopened.getAttempt(attemptId)?.role).toBe('implement')
    reopened.close()
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('ledger.db.pre-build-rename'))).toEqual(['ledger.db.pre-build-rename'])
  })

  it('rejects a ledger that mixes pre-rename and current table names', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-ledger-mixed-'))
    const sourceWorkspace = workspace('mixed')
    const ledger = new Ledger(path.join(dir, 'source.db'))
    const build = ledger.createBuild({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models })
    ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })
    ledger.prepareBuildFolder(build.id)
    ledger.close()

    const folder = new DatabaseSync(path.join(sourceWorkspace, '.gauntlet-gamesmith', 'ledger.db'))
    folder.exec('CREATE TABLE loops (id TEXT PRIMARY KEY)')
    folder.close()

    const target = new Ledger(path.join(dir, 'target.db'))
    expect(() => target.importBuildFolder(sourceWorkspace)).toThrow(/mixes pre-rename and current table names/)
    target.close()
  })

  it('leaves legacy workspace identity unavailable when the portable history does not match', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const build = ledger.createBuild({ prompt: 'canonical prompt', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    ledger.close()

    const registry = new DatabaseSync(path.join(dir!, 'ledger.db'))
    registry.prepare('UPDATE builds SET workspace_dev = NULL, workspace_ino = NULL, play_trusted = 0 WHERE id = ?').run(build.id)
    registry.close()
    const portable = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'))
    portable.prepare('UPDATE builds SET prompt = ? WHERE id = ?').run('different project history', build.id)
    portable.close()

    const reopened = new Ledger(path.join(dir!, 'ledger.db'))
    expect(reopened.getBuild(build.id)?.workspaceIdentity).toBeNull()
    expect(() => reopened.assertBuildWorkspaceIdentity(build.id)).toThrow(/identity is unavailable/)
    expect(reopened.eventsForBuild(build.id).some((event) =>
      event.kind === 'mirror-repair' && event.text.includes('identity is unavailable'),
    )).toBe(true)
    reopened.close()
  })

  it('rolls a multi-row transition back without changing the folder mirror', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir, maxRounds: 2, budgetUsd: null, models })

    expect(() =>
      ledger.transaction(() => {
        ledger.patchBuild(build.id, { status: 'passed' })
        ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'should roll back' })
        throw new Error('fail the transition')
      }),
    ).toThrow(/fail the transition/)

    expect(ledger.getBuild(build.id)?.status).toBe('running')
    expect(ledger.attemptsForBuild(build.id)).toEqual([])
    const folder = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(folder.prepare('SELECT status FROM builds WHERE id = ?').get(build.id)).toEqual({ status: 'running' })
    expect(folder.prepare('SELECT COUNT(*) AS count FROM phase_attempts').get()).toEqual({ count: 0 })
    folder.close()
    ledger.close()
  })

  it('commits a multi-row transition and rebuilds its folder mirror once', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    let attemptId = ''
    ledger.transaction(() => {
      ledger.patchBuild(build.id, { round: 1 })
      attemptId = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' }).id
      ledger.appendEvent({ buildId: build.id, attemptId, ts: '2026-01-01T00:00:00.000Z', kind: 'system', text: 'queued atomically' })
    })

    const folder = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(folder.prepare('SELECT round FROM builds WHERE id = ?').get(build.id)).toEqual({ round: 1 })
    expect(folder.prepare('SELECT id FROM phase_attempts WHERE build_id = ?').get(build.id)).toEqual({ id: attemptId })
    expect(folder.prepare('SELECT text FROM events WHERE build_id = ?').get(build.id)).toEqual({ text: 'queued atomically' })
    folder.close()
    ledger.close()
  })

  it('commits the canonical registry before the portable mirror', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace('canonical-first')
    const build = ledger.createBuild({ prompt: 'canonical first', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const internal = ledger as unknown as {
      db: DatabaseSync
      folderDbs: Map<string, { db: DatabaseSync }>
    }
    const folder = internal.folderDbs.get(fs.realpathSync(workspaceDir))!.db
    const order: string[] = []
    const originalCanonicalExec = internal.db.exec.bind(internal.db)
    const originalFolderExec = folder.exec.bind(folder)
    const canonical = vi.spyOn(internal.db, 'exec').mockImplementation((sql) => {
      if (sql.trim() === 'COMMIT') order.push('canonical')
      return originalCanonicalExec(sql)
    })
    const portable = vi.spyOn(folder, 'exec').mockImplementation((sql) => {
      if (sql.trim() === 'COMMIT') order.push('portable')
      return originalFolderExec(sql)
    })
    try {
      ledger.patchBuild(build.id, { title: 'ordered' })
      expect(order).toEqual(['canonical', 'portable'])
    } finally {
      canonical.mockRestore()
      portable.mockRestore()
      ledger.close()
    }
  })

  it('repairs from canonical when a portable commit fails after canonical commit', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace('post-canonical-repair')
    const build = ledger.createBuild({ prompt: 'repair me', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const internal = ledger as unknown as { folderDbs: Map<string, { db: DatabaseSync }> }
    const folder = internal.folderDbs.get(fs.realpathSync(workspaceDir))!.db
    const originalExec = folder.exec.bind(folder)
    let failCommit = true
    const portable = vi.spyOn(folder, 'exec').mockImplementation((sql) => {
      if (sql.trim() === 'COMMIT' && failCommit) {
        failCommit = false
        throw new Error('synthetic portable commit failure')
      }
      return originalExec(sql)
    })
    try {
      expect(() => ledger.patchBuild(build.id, { title: 'canonical survived' })).not.toThrow()
      expect(ledger.getBuild(build.id)?.title).toBe('canonical survived')
      expect(ledger.eventsForBuild(build.id).some((event) => event.kind === 'mirror-repair' && event.text.includes('synthetic portable commit failure'))).toBe(true)
      const repaired = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
      expect(repaired.prepare('SELECT title FROM builds WHERE id = ?').get(build.id)).toEqual({ title: 'canonical survived' })
      repaired.close()
    } finally {
      portable.mockRestore()
      ledger.close()
    }
  })

  it('rolls the canonical registry back when a deferred mirror rebuild fails', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const internal = ledger as unknown as { mirrorBuild(buildId: string, write: (db: DatabaseSync) => void): void }
    const mirror = internal.mirrorBuild.bind(ledger)
    internal.mirrorBuild = (buildId, _write) => mirror(buildId, () => { throw new Error('mirror unavailable') })

    expect(() => ledger.transaction(() => ledger.patchBuild(build.id, { status: 'passed' }))).toThrow(/mirror unavailable/)
    internal.mirrorBuild = mirror

    expect(ledger.getBuild(build.id)?.status).toBe('running')
    const folder = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(folder.prepare('SELECT status FROM builds WHERE id = ?').get(build.id)).toEqual({ status: 'running' })
    folder.close()
    ledger.close()
  })

  it('repairs a mirror left ahead of the canonical registry when reopening', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const build = ledger.createBuild({ prompt: 'canonical', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    ledger.close()

    const folderPath = path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db')
    const ahead = new DatabaseSync(folderPath)
    ahead.prepare("UPDATE builds SET status = 'passed', prompt = 'ahead mirror' WHERE id = ?").run(build.id)
    ahead.close()

    const reopened = new Ledger(path.join(dir!, 'ledger.db'))
    const repaired = new DatabaseSync(folderPath, { readOnly: true })
    expect(repaired.prepare('SELECT status, prompt FROM builds WHERE id = ?').get(build.id)).toEqual({
      status: 'running',
      prompt: 'canonical',
    })
    repaired.close()
    reopened.close()
  })

  it('fails closed when a cached mirror is replaced and preserves the competing entry', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const build = ledger.createBuild({ prompt: 'canonical', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'keep build' })
    const originalTitle = ledger.getBuild(build.id)?.title
    const folderPath = path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db')
    fs.unlinkSync(folderPath)
    fs.writeFileSync(folderPath, 'agent replacement')

    expect(() => ledger.patchBuild(build.id, { title: 'must roll back' })).toThrow(/changed identity/)
    expect(ledger.getBuild(build.id)?.title).toBe(originalTitle)
    expect(fs.readFileSync(folderPath, 'utf8')).toBe('agent replacement')
    ledger.close()
  })

  it('rebuilds a missing mirror on startup and records an actionable repair failure', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const build = ledger.createBuild({ prompt: 'canonical', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const folderPath = path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db')
    ledger.close()
    fs.unlinkSync(folderPath)

    const rebuilt = new Ledger(path.join(dir!, 'ledger.db'))
    const portable = new DatabaseSync(folderPath, { readOnly: true })
    expect(portable.prepare('SELECT prompt FROM builds WHERE id = ?').get(build.id)).toEqual({ prompt: 'canonical' })
    portable.close()
    rebuilt.close()

    fs.unlinkSync(folderPath)
    fs.symlinkSync(path.join(workspaceDir, 'outside.db'), folderPath)
    const observed = new Ledger(path.join(dir!, 'ledger.db'))
    expect(observed.eventsForBuild(build.id).some((event) => event.kind === 'mirror-repair' && event.text.includes('repair failed'))).toBe(true)
    observed.close()
  })

  it('patches the exact bounded effective prompt with credential redaction', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'queued prompt' })
    const secret = `ghp_${'a'.repeat(36)}`

    ledger.patchAttempt(attempt.id, { prompt: `resume exact ${secret}` })
    expect(ledger.getAttempt(attempt.id)?.prompt).toBe('resume exact [REDACTED]')
    const longPrompt = 'x'.repeat(100_000)
    ledger.patchAttempt(attempt.id, { prompt: longPrompt })
    expect(ledger.recentAttemptProjectionForBuild(build.id, 1).attempts[0].prompt).toHaveLength(65_536)
    expect(ledger.attemptPrompt(build.id, 'implement', 1)).toEqual({ attemptId: attempt.id, prompt: longPrompt })
    expect(() => ledger.patchAttempt(attempt.id, { prompt: 'x'.repeat(2 * 1024 * 1024 + 1) })).toThrow(/prompt safety limit/)
    ledger.close()
  })

  it('bounds build-list prompts at the SQLite projection while detail stays exact', () => {
    const ledger = makeLedger()
    const prompt = 'p'.repeat(100_000)
    const build = ledger.createBuild({ prompt, workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })

    expect(ledger.recentBuilds(1)[0].prompt).toHaveLength(1_024)
    expect(ledger.getBuild(build.id)?.prompt).toBe(prompt)
    ledger.close()
  })

  it('persists strict canonical process ownership in both ledgers and clears it explicitly', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'codex', prompt: 'go' })
    const ownership = {
      pid: 4242,
      processIdentity: 'Thu Sep  3 01:00:00 2026',
      groupIdentities: ['4242:Thu Sep  3 01:00:00 2026', '4243:Thu Sep  3 01:00:01 2026'],
      startedAtMs: 1_788_399_600_000,
      outDev: 1,
      outIno: 2,
      errDev: 1,
      errIno: 3,
    }

    ledger.setAttemptProcessOwnership(attempt.id, ownership)
    expect(ledger.attemptProcessOwnership(attempt.id)).toEqual(ownership)
    expect(ledger.attemptsWithProcessOwnership()).toEqual([{ attempt: ledger.getAttempt(attempt.id), ownership }])
    const mirror = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(mirror.prepare('SELECT process_ownership_json FROM phase_attempts WHERE id = ?').get(attempt.id)).toEqual({
      process_ownership_json: JSON.stringify(ownership),
    })
    mirror.close()

    expect(() => ledger.setAttemptProcessOwnership(attempt.id, { ...ownership, pid: 1 })).toThrow(/ownership is invalid/)
    expect(() => ledger.setAttemptProcessOwnership(attempt.id, { ...ownership, outIno: 0 })).toThrow(/ownership is invalid/)
    expect(() => ledger.setAttemptProcessOwnership(attempt.id, { ...ownership, groupIdentities: ['4243:Thu Sep  3 01:00:01 2026'] })).toThrow(/leader identity/)
    expect(() => ledger.setAttemptProcessOwnership(attempt.id, { ...ownership, processIdentity: 'not-a-ps-start-time' })).toThrow(/ownership is invalid/)
    expect(() => ledger.setAttemptProcessOwnership(attempt.id, { ...ownership, processIdentity: `ghp_${'a'.repeat(36)}` })).toThrow(/ownership is invalid/)
    expect(() => ledger.setAttemptProcessOwnership('00000000-0000-4000-8000-000000000000', ownership)).toThrow(/target was not found/)
    const other = ledger.createAttempt({ buildId: build.id, round: 1, role: 'critique', harness: 'claude', prompt: 'inspect' })
    expect(() => ledger.setAttemptProcessOwnership(other.id, ownership)).toThrow(/Another attempt still retains/)
    ledger.patchAttempt(attempt.id, { status: 'interrupted' })
    expect(ledger.attemptsWithProcessOwnership()[0].attempt.status).toBe('interrupted')
    ledger.updateAttemptProcessGroupIdentities(attempt.id, [
      '4243:Thu Sep  3 01:00:01 2026',
      '4244:Thu Sep  3 01:00:02 2026',
    ])
    expect(ledger.attemptProcessOwnership(attempt.id)?.groupIdentities).toEqual([
      '4242:Thu Sep  3 01:00:00 2026',
      '4243:Thu Sep  3 01:00:01 2026',
      '4244:Thu Sep  3 01:00:02 2026',
    ])
    expect(() => ledger.updateAttemptProcessGroupIdentities(attempt.id, ['5000:Thu Sep  3 02:00:00 2026'])).toThrow(/continuity/)
    expect(() => ledger.updateAttemptProcessGroupIdentities(attempt.id, [
      '4243:Thu Sep  3 01:00:01 2026',
      ...Array.from({ length: 256 }, (_, index) => `${5_000 + index}:Thu Sep  3 02:00:00 2026`),
    ])).toThrow(/invalid/)
    ledger.clearAttemptProcessOwnership(attempt.id)
    expect(ledger.attemptProcessOwnership(attempt.id)).toBeNull()
    expect(ledger.attemptsWithProcessOwnership()).toEqual([])
    ledger.setAttemptProcessOwnership(other.id, ownership)
    expect(ledger.attemptsWithProcessOwnership()[0].attempt.id).toBe(other.id)
    ledger.clearAttemptProcessOwnership(other.id)
    ledger.close()
  })

  it('projects the latest role id and exact successful round revision without full build rows', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir: workspace(), maxRounds: 2, budgetUsd: null, models })
    const first = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'codex', prompt: 'first' })
    const second = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'codex', prompt: 'second' })
    ledger.patchAttempt(first.id, { status: 'succeeded', revision: 'a'.repeat(40) })
    ledger.patchAttempt(second.id, { status: 'succeeded', revision: 'b'.repeat(40) })

    expect(ledger.latestAttemptIdForRole(build.id, 'implement')).toBe(second.id)
    expect(ledger.latestAttemptIdExcept(build.id, second.id)).toBe(first.id)
    expect(ledger.latestAttemptIdExcept(build.id, first.id)).toBe(second.id)
    expect(ledger.hasAttemptErrorPrefixForWorkspace(build.workspaceDir, 'UNKNOWN OWNERSHIP')).toBe(false)
    ledger.patchAttempt(first.id, { error: 'UNKNOWN OWNERSHIP: retained' })
    expect(ledger.hasAttemptErrorPrefixForWorkspace(build.workspaceDir, 'UNKNOWN OWNERSHIP')).toBe(true)
    expect(() => ledger.hasAttemptErrorPrefixForWorkspace(build.workspaceDir, '')).toThrow(/bounded/)
    expect(ledger.succeededImplementRevision(build.id, 1)).toBe('b'.repeat(40))
    expect(ledger.succeededImplementRevision(build.id, 2)).toBeNull()
    ledger.close()
  })

  it('projects the latest critique attempt for every bounded round', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir: workspace(), maxRounds: 3, budgetUsd: null, models })
    ledger.createAttempt({ buildId: build.id, round: 1, role: 'critique', harness: 'codex', prompt: 'round 1 first' })
    const latest = ledger.createAttempt({ buildId: build.id, round: 1, role: 'critique', harness: 'codex', prompt: 'round 1 retry' })
    ledger.createAttempt({ buildId: build.id, round: 2, role: 'critique', harness: 'codex', prompt: 'round 2' })
    const projected = ledger.latestAttemptProjectionPerRound(build.id, 'critique', 100).attempts
    expect(projected.map((attempt) => [attempt.round, attempt.id])).toEqual([[1, latest.id], [2, projected[1].id]])
    expect(projected[1].prompt).toBe('round 2')
    ledger.close()
  })

  it('rejects unsafe per-build accounting values before aggregate projection', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })
    expect(() => ledger.patchAttempt(attempt.id, { costUsd: Number.MAX_VALUE })).toThrow(/persisted safety range/)
    expect(() => ledger.patchAttempt(attempt.id, { inputTokens: 1_000_000_001 })).toThrow(/persisted safety range/)
    expect(ledger.attemptAggregate(build.id)).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0, phaseAttemptCount: 1 })
    ledger.close()
  })

  it('validates and redacts build provenance before either ledger persists it', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })
    const secret = `ghp_${'c'.repeat(36)}`

    ledger.patchAttempt(attempt.id, {
      model: secret,
      cliVersion: `claude ${secret}`,
      costSource: `stream ${secret}`,
      accountLabel: `claude:${secret}`,
      machineLabel: `host-${secret}`,
    })
    expect(ledger.getAttempt(attempt.id)).toMatchObject({
      model: '[REDACTED]',
      cliVersion: 'claude [REDACTED]',
      costSource: 'stream [REDACTED]',
      accountLabel: 'claude:[REDACTED]',
      machineLabel: 'host-[REDACTED]',
    })
    expect(() => ledger.patchAttempt(attempt.id, { model: 'model with spaces' })).toThrow(/invalid identifier/)
    expect(() => ledger.patchAttempt(attempt.id, { effort: 'unbounded' })).toThrow(/effort is invalid/)
    expect(() => ledger.patchAttempt(attempt.id, { priceTableVersion: 'latest' })).toThrow(/price-table version is invalid/)
    expect(() => ledger.patchAttempt(attempt.id, { promptSha256: 'not-a-hash' })).toThrow(/prompt hash is invalid/)

    const folder = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(JSON.stringify(folder.prepare('SELECT model, cli_version, cost_source, account_label, machine_label FROM phase_attempts WHERE id = ?').get(attempt.id))).not.toContain(secret)
    folder.close()
    ledger.close()
  })

  it('only persists canonical session ids and nulls malformed legacy values', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })

    ledger.patchAttempt(attempt.id, { sessionId: 'session_01-safe' })
    expect(ledger.getAttempt(attempt.id)?.sessionId).toBe('session_01-safe')
    expect(() => ledger.patchAttempt(attempt.id, { sessionId: '../private/transcript' })).toThrow(/session id has an invalid format/)
    expect(ledger.getAttempt(attempt.id)?.sessionId).toBe('session_01-safe')
    ledger.close()

    const dbPath = path.join(dir!, 'ledger.db')
    const raw = new DatabaseSync(dbPath)
    raw.prepare('UPDATE phase_attempts SET session_id = ? WHERE id = ?').run('../legacy/private/transcript', attempt.id)
    raw.close()
    const reopened = new Ledger(dbPath)
    expect(reopened.getAttempt(attempt.id)?.sessionId).toBeNull()
    reopened.close()
  })

  it('normalizes safe additive fields and rejects malformed persisted JSON', () => {
    const ledger = makeLedger()
    const build = ledger.createBuild({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })
    ledger.close()
    const dbPath = path.join(dir!, 'ledger.db')
    const raw = new DatabaseSync(dbPath)
    raw.prepare('UPDATE phase_attempts SET metrics_json = ? WHERE id = ?').run(
      JSON.stringify({
        agents: [{ id: 'orchestrator', label: 'orchestrator', model: null, messages: 1, tokens: { input: 2, output: 1 }, firstTs: null, lastTs: null }],
        perModel: {},
      }),
      attempt.id,
    )
    raw.close()
    const reopened = new Ledger(dbPath)
    expect(reopened.getAttempt(attempt.id)?.metrics?.agents[0].tokens).toEqual({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 })
    reopened.close()

    const malformed = new DatabaseSync(dbPath)
    malformed.prepare('UPDATE phase_attempts SET verdict_json = ? WHERE id = ?').run(
      JSON.stringify({ score: '0.9', pass: true, summary: 'coercion must fail', findings: [] }),
      attempt.id,
    )
    malformed.close()
    const invalid = new Ledger(dbPath)
    expect(() => invalid.getAttempt(attempt.id)).toThrow(/verdict contract/)
    invalid.close()
  })

  it('canonicalizes workspace aliases so one mirror retains every build', () => {
    const ledger = makeLedger()
    const real = workspace('real-project')
    const alias = path.join(dir!, 'project-alias')
    fs.symlinkSync(real, alias)
    const first = ledger.createBuild({ prompt: 'first', workspaceDir: real, maxRounds: 1, budgetUsd: null, models })
    const second = ledger.createBuild({ prompt: 'second', workspaceDir: alias, maxRounds: 1, budgetUsd: null, models })

    expect(ledger.getBuild(second.id)?.workspaceDir).toBe(fs.realpathSync(real))
    ledger.prepareBuildFolder(second.id)
    const folder = new DatabaseSync(path.join(real, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(folder.prepare('SELECT id FROM builds ORDER BY created_at, rowid').all()).toEqual([{ id: first.id }, { id: second.id }])
    folder.close()
    ledger.close()
  })

  it('rejects a planted metadata-directory symlink before creating a registry build', () => {
    const ledger = makeLedger()
    const project = workspace('symlink-project')
    const outside = workspace('outside-metadata')
    fs.symlinkSync(outside, path.join(project, '.gauntlet-gamesmith'))

    expect(() =>
      ledger.createBuild({ prompt: 'must not escape', workspaceDir: project, maxRounds: 1, budgetUsd: null, models }),
    ).toThrow(/must be a real directory/)
    expect(ledger.builds()).toEqual([])
    expect(fs.readdirSync(outside)).toEqual([])
    ledger.close()
  })

  it('rejects planted SQLite sidecar symlinks before opening a workspace ledger', () => {
    const ledger = makeLedger()
    const project = workspace('sidecar-project')
    const metadata = path.join(project, '.gauntlet-gamesmith')
    fs.mkdirSync(metadata)
    const outside = path.join(dir!, 'outside-sidecar')
    fs.writeFileSync(outside, 'preserve')
    fs.symlinkSync(outside, path.join(metadata, 'ledger.db-journal'))

    expect(() =>
      ledger.createBuild({ prompt: 'must not open sidecar', workspaceDir: project, maxRounds: 1, budgetUsd: null, models }),
    ).toThrow(/must be an unlinked regular file/)
    expect(ledger.builds()).toEqual([])
    expect(fs.readFileSync(outside, 'utf8')).toBe('preserve')
    ledger.close()
  })

  it('rejects a hard-linked workspace ledger before SQLite can mutate its other name', () => {
    const ledger = makeLedger()
    const project = workspace('hardlink-project')
    const metadata = path.join(project, '.gauntlet-gamesmith')
    fs.mkdirSync(metadata)
    const outside = path.join(dir!, 'outside-ledger')
    fs.writeFileSync(outside, 'preserve')
    fs.linkSync(outside, path.join(metadata, 'ledger.db'))

    expect(() =>
      ledger.createBuild({ prompt: 'must not open hard link', workspaceDir: project, maxRounds: 1, budgetUsd: null, models }),
    ).toThrow(/must be an unlinked regular file/)
    expect(ledger.builds()).toEqual([])
    expect(fs.readFileSync(outside, 'utf8')).toBe('preserve')
    ledger.close()
  })
})

describe('Ledger deletion and report storage', () => {
  it('forgets a build without touching the folder ledger, so it can be imported back', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace('deletable')
    const build = ledger.createBuild({ prompt: 'build it', workspaceDir, maxRounds: 5, budgetUsd: null, models })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'do it' })
    ledger.appendEvent({ buildId: build.id, attemptId: attempt.id, ts: new Date().toISOString(), kind: 'system', text: 'started' })
    ledger.prepareBuildFolder(build.id)

    expect(ledger.deleteBuild(build.id)).toBe(true)
    expect(ledger.getBuild(build.id)).toBeNull()
    expect(ledger.attemptsForBuild(build.id)).toEqual([])
    expect(ledger.eventsForBuild(build.id)).toEqual([])
    expect(fs.existsSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'))).toBe(true)

    const [reimported] = ledger.importBuildFolder(workspaceDir)
    expect(reimported.build.id).toBe(build.id)
    expect(reimported.attempts).toHaveLength(1)
  })

  it('says so when the build was already gone', () => {
    expect(makeLedger().deleteBuild('nope')).toBe(false)
  })

  it('lists the builds sharing a project folder', () => {
    const ledger = makeLedger()
    const shared = workspace('shared')
    const first = ledger.createBuild({ prompt: 'one', workspaceDir: shared, maxRounds: 2, budgetUsd: null, models })
    const second = ledger.createBuild({ prompt: 'two', workspaceDir: shared, maxRounds: 2, budgetUsd: null, models })
    ledger.createBuild({ prompt: 'three', workspaceDir: workspace('other'), maxRounds: 2, budgetUsd: null, models })
    expect(ledger.buildsInWorkspace(shared).map((build) => build.id).sort()).toEqual([first.id, second.id].sort())
  })

  it('stores, updates and removes reports', () => {
    const ledger = makeLedger()
    const report = {
      id: 'rep1',
      name: 'Opus vs Fable',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      capturedAt: '2026-09-01T00:00:00.000Z',
      rows: [],
    }
    ledger.saveReport(report)
    expect(ledger.getReport('rep1')?.name).toBe('Opus vs Fable')
    ledger.saveReport({ ...report, name: 'Renamed' })
    expect(ledger.reports()).toHaveLength(1)
    expect(ledger.getReport('rep1')?.name).toBe('Renamed')
    expect(ledger.deleteReport('rep1')).toBe(true)
    expect(ledger.deleteReport('rep1')).toBe(false)
    expect(ledger.reports()).toEqual([])
  })
})
