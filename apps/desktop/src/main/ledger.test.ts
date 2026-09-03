import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { defaultLoopTitle, Ledger, MAX_MATERIALIZED_RUN_HISTORY, MAX_OPEN_FOLDER_DATABASES } from './ledger'

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
      ledger.createLoop({ prompt: `loop ${index}`, workspaceDir, maxRounds: 1, budgetUsd: null, models })
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
    const loop = ledger.createLoop({ prompt: 'bounded recovery', workspaceDir, maxRounds: 1, budgetUsd: null, models })
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

  it('derives concise, tasteful run titles from prompts', () => {
    expect(defaultLoopTitle('Build "Pac-Claude" — a modern AAA game')).toBe('Pac-claude')
    expect(defaultLoopTitle('Create a polished authentication flow: include passkeys')).toBe('A polished authentication flow')
  })

  it('detects running loop or attempt activity without materializing history', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'activity', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    expect(ledger.hasRunningActivity()).toBe(true)
    expect(ledger.hasRunningActivityForWorkspace(loop.workspaceDir)).toBe(true)
    ledger.patchLoop(loop.id, { status: 'stopped' })
    expect(ledger.hasRunningActivity()).toBe(false)
    expect(ledger.hasRunningActivityForWorkspace(loop.workspaceDir)).toBe(false)
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'go' })
    ledger.patchRun(run.id, { status: 'running' })
    expect(ledger.hasRunningActivity()).toBe(true)
    ledger.patchRun(run.id, { status: 'interrupted' })
    expect(ledger.hasRunningActivity()).toBe(false)
    const other = ledger.createLoop({ prompt: 'other id, same workspace', workspaceDir: loop.workspaceDir, maxRounds: 1, budgetUsd: null, models })
    expect(other.id).not.toBe(loop.id)
    expect(ledger.hasRunningActivity()).toBe(true)
    ledger.patchLoop(other.id, { status: 'stopped' })
    expect(ledger.hasRunningActivity()).toBe(false)
    ledger.close()
  })

  it('answers lifecycle lookups with bounded scalar or single-row queries', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'targeted lookups', workspaceDir: workspace(), maxRounds: 3, budgetUsd: null, models })
    const reference = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'claude', prompt: 'study' })
    ledger.patchRun(reference.id, { status: 'succeeded' })
    ledger.appendEvent({
      loopId: loop.id,
      runId: reference.id,
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'artifact',
      text: `Reference Pack frozen at sha256:${'a'.repeat(64)}`,
    })
    const first = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'first' })
    ledger.patchRun(first.id, { status: 'failed', sessionId: 'thread-1', revision: 'b'.repeat(40) })
    const pause = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'pause' })
    ledger.patchRun(pause.id, { status: 'interrupted', error: 'retry scheduled for 2026-01-01T00:01:00.000Z' })
    const queued = ledger.createRun({ loopId: loop.id, round: 2, role: 'implement', harness: 'codex', prompt: 'queued' })
    const active = ledger.createRun({ loopId: loop.id, round: 2, role: 'critique', harness: 'claude', prompt: 'active' })
    ledger.patchRun(active.id, {
      status: 'running',
      verdict: { score: 0.75, pass: false, summary: 'close', findings: [] },
    })

    expect(ledger.hasRunRole(loop.id, 'reference')).toBe(true)
    expect(ledger.firstSucceededRunIdForRole(loop.id, 'reference')).toBe(reference.id)
    expect(ledger.eventTextForRunWithPrefix(reference.id, 'Reference Pack frozen at sha256:')).toContain('a'.repeat(64))
    expect(ledger.failedRunCount(loop.id, 'implement', 1)).toBe(1)
    expect(ledger.rateLimitPauseCount(loop.id, 'implement', 1)).toBe(1)
    expect(ledger.latestInterruptedRunForLoop(loop.id)?.id).toBe(pause.id)
    expect(ledger.oldestQueuedRunForLoop(loop.id)?.id).toBe(queued.id)
    expect(ledger.activeRunForLoop(loop.id)?.id).toBe(active.id)
    expect(ledger.latestImplementSessionId(loop.id, 1, pause.id)).toBe('thread-1')
    expect(ledger.previousImplementRevision(loop.id, 2)).toBe('b'.repeat(40))
    expect(ledger.bestVerdictScore(loop.id)).toBe(0.75)
    ledger.close()
  })

  it('records a redacted canonical control event when the workspace mirror is unavailable', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace('canonical-event')
    const loop = ledger.createLoop({ prompt: 'control plane', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const displaced = `${workspaceDir}-displaced`
    fs.renameSync(workspaceDir, displaced)
    const secret = `ghp_${'a'.repeat(36)}`

    expect(() => ledger.appendCanonicalEvent({
      loopId: loop.id,
      runId: null,
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'process-control',
      channel: 'error',
      text: `Could not verify process ${secret}`,
    })).not.toThrow()
    expect(ledger.eventsForLoop(loop.id).at(-1)?.text).toBe('Could not verify process [REDACTED]')
    ledger.close()
  })

  it('atomically cancels a running run and stops its loop without touching an unsafe mirror', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace('canonical-quit')
    const loop = ledger.createLoop({ prompt: 'quit safely', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'work' })
    ledger.patchRun(run.id, { status: 'running' })
    const displaced = `${workspaceDir}-displaced`
    fs.renameSync(workspaceDir, displaced)
    const finishedAt = '2026-01-01T00:00:01.000Z'

    ledger.cancelRunAndStopLoopCanonical(loop.id, run.id, 'Stopped safely for quit.', finishedAt, 1_000)

    expect(ledger.getRun(run.id)).toMatchObject({ status: 'cancelled', error: 'Stopped safely for quit.', durationMs: 1_000, finishedAt })
    expect(ledger.getLoop(loop.id)).toMatchObject({ status: 'stopped', stopReason: 'Stopped safely for quit.' })
    expect(ledger.eventsForLoop(loop.id).at(-1)).toMatchObject({ runId: run.id, kind: 'process-control', text: 'Stopped safely for quit.' })
    expect(() => ledger.cancelRunAndStopLoopCanonical(loop.id, run.id, 'again', finishedAt, 1_000)).toThrow(/not running/)
    ledger.close()
  })

  it('refuses to materialize an unbounded full run history', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'bounded history', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    const internal = ledger as unknown as { db: DatabaseSync }
    internal.db.prepare(
      `WITH RECURSIVE sequence(n) AS (
         VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
       )
       INSERT INTO runs (id, loop_id, round, role, harness, status, prompt, created_at)
       SELECT printf('00000000-0000-4000-8000-%012d', n), ?, 1, 'implement', 'claude', 'succeeded', 'bounded', '2026-01-01T00:00:00.000Z'
       FROM sequence`,
    ).run(MAX_MATERIALIZED_RUN_HISTORY + 1, loop.id)

    expect(() => ledger.runsForLoop(loop.id)).toThrow(/administrative materialization limit/)
    expect(ledger.runCount(loop.id)).toBe(MAX_MATERIALIZED_RUN_HISTORY + 1)
    ledger.close()
  })

  it('round-trips loops, runs, verdicts and metrics', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'build it', workspaceDir: workspace(), maxRounds: 5, budgetUsd: 50, models })
    expect(loop.status).toBe('running')
    expect(loop.round).toBe(0)
    expect(loop.title).toBe('It')
    expect(loop.playTrusted).toBe(true)
    expect(loop.workspaceIdentity).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) })
    expect(ledger.assertLoopWorkspaceIdentity(loop.id)).toBe(loop.workspaceDir)
    expect(loop.models.criticModel).toBe('gpt-5.6-sol')

    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'p1' })
    expect(ledger.nextQueuedRun(loop.id)!.id).toBe(run.id)

    ledger.patchRun(run.id, {
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
    const saved = ledger.getRun(run.id)!
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
    expect(ledger.nextQueuedRun(loop.id)).toBeNull()

    ledger.patchLoop(loop.id, { status: 'passed', totalCostUsd: 4.2, stopReason: 'done' })
    expect(ledger.latestLoop()!.status).toBe('passed')
    expect(ledger.runningLoop()).toBeNull()
    ledger.close()
  })

  it('persists an operator-supplied run title', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'Build a game', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    ledger.patchLoop(loop.id, { title: 'Arcade study' })

    expect(ledger.getLoop(loop.id)?.title).toBe('Arcade study')
    ledger.close()
  })

  it('gives repeated prompts distinct prompt-derived run names', () => {
    const ledger = makeLedger()
    const first = ledger.createLoop({ prompt: 'Build a neon Pac-Man game', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    ledger.patchLoop(first.id, { status: 'stopped' })
    const second = ledger.createLoop({ prompt: 'Build a neon Pac-Man game', workspaceDir: workspace('second'), maxRounds: 1, budgetUsd: null, models })

    expect(first.title).toBe('A neon Pac-man game')
    expect(second.title).toBe('A neon Pac-man game (2)')
    ledger.close()
  })

  it('appends and reads back events in order', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    for (let i = 0; i < 5; i += 1) ledger.appendEvent({ loopId: loop.id, runId: null, ts: `t${i}`, kind: 'system', text: `line ${i}` })
    const lines = ledger.eventsForLoop(loop.id, 3)
    expect(lines.map((l) => l.text)).toEqual(['line 2', 'line 3', 'line 4'])
    ledger.close()
  })

  it('truncates event text in SQL before renderer projection', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    ledger.appendEvent({ loopId: loop.id, runId: null, ts: '2026-01-01T00:00:00.000Z', kind: 'system', text: 'x'.repeat(100_000) })
    const lines = ledger.eventsForLoop(loop.id)
    expect(lines[0].text).toMatch(/oversized log entries were omitted/)
    const line = lines[1]
    expect(line.text.length).toBeLessThan(4_100)
    expect(line.text).toMatch(/projection truncated/)
    ledger.close()
  })

  it('redacts credential-shaped log text before either ledger persists it', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const secret = `ghp_${'a'.repeat(36)}`
    const agentSecret = `sk-proj-${'f'.repeat(24)}`
    ledger.appendEvent({
      loopId: loop.id,
      runId: null,
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'system',
      text: `tool output ${secret}\nAWS_SECRET_ACCESS_KEY=aws-secret\nCookie: session=browser-secret`,
      agentId: agentSecret,
    })

    expect(ledger.eventsForLoop(loop.id)[0].text).toBe('tool output [REDACTED]\nAWS_SECRET_ACCESS_KEY=[REDACTED]\nCookie: [REDACTED]')
    expect(ledger.eventsForLoop(loop.id)[0].agentId).toBe('[REDACTED]')
    const folder = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(folder.prepare('SELECT text, agent_id FROM events').get()).toEqual({
      text: 'tool output [REDACTED]\nAWS_SECRET_ACCESS_KEY=[REDACTED]\nCookie: [REDACTED]',
      agent_id: '[REDACTED]',
    })
    folder.close()
    ledger.close()
  })

  it('lists every run with the newest prompt first', () => {
    const ledger = makeLedger()
    const first = ledger.createLoop({ prompt: 'first', workspaceDir: workspace('one'), maxRounds: 1, budgetUsd: null, models })
    const second = ledger.createLoop({ prompt: 'second', workspaceDir: workspace('two'), maxRounds: 1, budgetUsd: null, models })

    expect(ledger.loops().map((loop) => loop.id)).toEqual([second.id, first.id])
    ledger.close()
  })

  it('requeues an orphaned run with the resume marker', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: workspace(), maxRounds: 3, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 2, role: 'implement', harness: 'claude', prompt: 'build it' })
    const revision = '0123456789abcdef0123456789abcdef01234567'
    ledger.patchRun(run.id, { status: 'running', revision })

    const requeued = ledger.requeueInterruptedRun(ledger.getRun(run.id)!)
    expect(ledger.getRun(run.id)!.status).toBe('interrupted')
    expect(ledger.getLoop(loop.id)!.status).toBe('running')
    expect(requeued.round).toBe(2)
    expect(requeued.status).toBe('queued')
    expect(requeued.prompt).toBe('[[gauntlet:resume]]\nbuild it')
    expect(requeued.revision).toBe(revision)
    // Requeuing the requeued run must not stack markers.
    const again = ledger.requeueInterruptedRun(requeued)
    expect(again.prompt).toBe('[[gauntlet:resume]]\nbuild it')
    expect(ledger.runningLoops().map((l) => l.id)).toEqual([loop.id])
    ledger.close()
  })

  it('migrates every missing column independently from the previous schema', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-ledger-legacy-'))
    const dbPath = path.join(dir, 'ledger.db')
    const workspaceDir = workspace()
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
    ).run('legacy-loop', 'old prompt', workspaceDir, 2, null, JSON.stringify(models), 'stopped', 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    legacy.prepare(
      `INSERT INTO runs
       (id, loop_id, round, role, harness, status, prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('legacy-run', 'legacy-loop', 1, 'implement', 'claude', 'succeeded', 'old run', '2026-01-01T00:00:00.000Z')
    legacy.close()

    const ledger = new Ledger(dbPath)
    // Rows with no durable local-origin proof fail closed. A new local run
    // explicitly writes trust=1; migrated history remains read-only.
    expect(ledger.getLoop('legacy-loop')).toMatchObject({ title: 'Old prompt', playTrusted: false })
    expect(ledger.getRun('legacy-run')).toMatchObject({
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
    expect(columns('loops')).toEqual(expect.arrayContaining(['title', 'play_trusted', 'workspace_dev', 'workspace_ino']))
    expect(columns('runs')).toEqual(
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
    migrated.close()
  })

  it('rolls a multi-row transition back without changing the folder mirror', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir, maxRounds: 2, budgetUsd: null, models })

    expect(() =>
      ledger.transaction(() => {
        ledger.patchLoop(loop.id, { status: 'passed' })
        ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'should roll back' })
        throw new Error('fail the transition')
      }),
    ).toThrow(/fail the transition/)

    expect(ledger.getLoop(loop.id)?.status).toBe('running')
    expect(ledger.runsForLoop(loop.id)).toEqual([])
    const folder = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(folder.prepare('SELECT status FROM loops WHERE id = ?').get(loop.id)).toEqual({ status: 'running' })
    expect(folder.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 })
    folder.close()
    ledger.close()
  })

  it('commits a multi-row transition and rebuilds its folder mirror once', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    let runId = ''
    ledger.transaction(() => {
      ledger.patchLoop(loop.id, { round: 1 })
      runId = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' }).id
      ledger.appendEvent({ loopId: loop.id, runId, ts: '2026-01-01T00:00:00.000Z', kind: 'system', text: 'queued atomically' })
    })

    const folder = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(folder.prepare('SELECT round FROM loops WHERE id = ?').get(loop.id)).toEqual({ round: 1 })
    expect(folder.prepare('SELECT id FROM runs WHERE loop_id = ?').get(loop.id)).toEqual({ id: runId })
    expect(folder.prepare('SELECT text FROM events WHERE loop_id = ?').get(loop.id)).toEqual({ text: 'queued atomically' })
    folder.close()
    ledger.close()
  })

  it('commits the canonical registry before the portable mirror', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace('canonical-first')
    const loop = ledger.createLoop({ prompt: 'canonical first', workspaceDir, maxRounds: 1, budgetUsd: null, models })
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
      ledger.patchLoop(loop.id, { title: 'ordered' })
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
    const loop = ledger.createLoop({ prompt: 'repair me', workspaceDir, maxRounds: 1, budgetUsd: null, models })
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
      expect(() => ledger.patchLoop(loop.id, { title: 'canonical survived' })).not.toThrow()
      expect(ledger.getLoop(loop.id)?.title).toBe('canonical survived')
      expect(ledger.eventsForLoop(loop.id).some((event) => event.kind === 'mirror-repair' && event.text.includes('synthetic portable commit failure'))).toBe(true)
      const repaired = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
      expect(repaired.prepare('SELECT title FROM loops WHERE id = ?').get(loop.id)).toEqual({ title: 'canonical survived' })
      repaired.close()
    } finally {
      portable.mockRestore()
      ledger.close()
    }
  })

  it('rolls the canonical registry back when a deferred mirror rebuild fails', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const internal = ledger as unknown as { mirrorLoop(loopId: string, write: (db: DatabaseSync) => void): void }
    const mirror = internal.mirrorLoop.bind(ledger)
    internal.mirrorLoop = (loopId, _write) => mirror(loopId, () => { throw new Error('mirror unavailable') })

    expect(() => ledger.transaction(() => ledger.patchLoop(loop.id, { status: 'passed' }))).toThrow(/mirror unavailable/)
    internal.mirrorLoop = mirror

    expect(ledger.getLoop(loop.id)?.status).toBe('running')
    const folder = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(folder.prepare('SELECT status FROM loops WHERE id = ?').get(loop.id)).toEqual({ status: 'running' })
    folder.close()
    ledger.close()
  })

  it('repairs a mirror left ahead of the canonical registry when reopening', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const loop = ledger.createLoop({ prompt: 'canonical', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    ledger.close()

    const folderPath = path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db')
    const ahead = new DatabaseSync(folderPath)
    ahead.prepare("UPDATE loops SET status = 'passed', prompt = 'ahead mirror' WHERE id = ?").run(loop.id)
    ahead.close()

    const reopened = new Ledger(path.join(dir!, 'ledger.db'))
    const repaired = new DatabaseSync(folderPath, { readOnly: true })
    expect(repaired.prepare('SELECT status, prompt FROM loops WHERE id = ?').get(loop.id)).toEqual({
      status: 'running',
      prompt: 'canonical',
    })
    repaired.close()
    reopened.close()
  })

  it('fails closed when a cached mirror is replaced and preserves the competing entry', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const loop = ledger.createLoop({ prompt: 'canonical', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'keep run' })
    const originalTitle = ledger.getLoop(loop.id)?.title
    const folderPath = path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db')
    fs.unlinkSync(folderPath)
    fs.writeFileSync(folderPath, 'agent replacement')

    expect(() => ledger.patchLoop(loop.id, { title: 'must roll back' })).toThrow(/changed identity/)
    expect(ledger.getLoop(loop.id)?.title).toBe(originalTitle)
    expect(fs.readFileSync(folderPath, 'utf8')).toBe('agent replacement')
    ledger.close()
  })

  it('rebuilds a missing mirror on startup and records an actionable repair failure', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const loop = ledger.createLoop({ prompt: 'canonical', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const folderPath = path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db')
    ledger.close()
    fs.unlinkSync(folderPath)

    const rebuilt = new Ledger(path.join(dir!, 'ledger.db'))
    const portable = new DatabaseSync(folderPath, { readOnly: true })
    expect(portable.prepare('SELECT prompt FROM loops WHERE id = ?').get(loop.id)).toEqual({ prompt: 'canonical' })
    portable.close()
    rebuilt.close()

    fs.unlinkSync(folderPath)
    fs.symlinkSync(path.join(workspaceDir, 'outside.db'), folderPath)
    const observed = new Ledger(path.join(dir!, 'ledger.db'))
    expect(observed.eventsForLoop(loop.id).some((event) => event.kind === 'mirror-repair' && event.text.includes('repair failed'))).toBe(true)
    observed.close()
  })

  it('patches the exact bounded effective prompt with credential redaction', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'queued prompt' })
    const secret = `ghp_${'a'.repeat(36)}`

    ledger.patchRun(run.id, { prompt: `resume exact ${secret}` })
    expect(ledger.getRun(run.id)?.prompt).toBe('resume exact [REDACTED]')
    const longPrompt = 'x'.repeat(100_000)
    ledger.patchRun(run.id, { prompt: longPrompt })
    expect(ledger.recentRunProjectionForLoop(loop.id, 1).runs[0].prompt).toHaveLength(65_536)
    expect(ledger.runPrompt(loop.id, 'implement', 1)).toEqual({ runId: run.id, prompt: longPrompt })
    expect(() => ledger.patchRun(run.id, { prompt: 'x'.repeat(2 * 1024 * 1024 + 1) })).toThrow(/prompt safety limit/)
    ledger.close()
  })

  it('bounds loop-list prompts at the SQLite projection while detail stays exact', () => {
    const ledger = makeLedger()
    const prompt = 'p'.repeat(100_000)
    const loop = ledger.createLoop({ prompt, workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })

    expect(ledger.recentLoops(1)[0].prompt).toHaveLength(1_024)
    expect(ledger.getLoop(loop.id)?.prompt).toBe(prompt)
    ledger.close()
  })

  it('persists strict canonical process ownership in both ledgers and clears it explicitly', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'go' })
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

    ledger.setRunProcessOwnership(run.id, ownership)
    expect(ledger.runProcessOwnership(run.id)).toEqual(ownership)
    expect(ledger.runsWithProcessOwnership()).toEqual([{ run: ledger.getRun(run.id), ownership }])
    const mirror = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(mirror.prepare('SELECT process_ownership_json FROM runs WHERE id = ?').get(run.id)).toEqual({
      process_ownership_json: JSON.stringify(ownership),
    })
    mirror.close()

    expect(() => ledger.setRunProcessOwnership(run.id, { ...ownership, pid: 1 })).toThrow(/ownership is invalid/)
    expect(() => ledger.setRunProcessOwnership(run.id, { ...ownership, outIno: 0 })).toThrow(/ownership is invalid/)
    expect(() => ledger.setRunProcessOwnership(run.id, { ...ownership, groupIdentities: ['4243:Thu Sep  3 01:00:01 2026'] })).toThrow(/leader identity/)
    expect(() => ledger.setRunProcessOwnership(run.id, { ...ownership, processIdentity: 'not-a-ps-start-time' })).toThrow(/ownership is invalid/)
    expect(() => ledger.setRunProcessOwnership(run.id, { ...ownership, processIdentity: `ghp_${'a'.repeat(36)}` })).toThrow(/ownership is invalid/)
    expect(() => ledger.setRunProcessOwnership('00000000-0000-4000-8000-000000000000', ownership)).toThrow(/target was not found/)
    const other = ledger.createRun({ loopId: loop.id, round: 1, role: 'critique', harness: 'claude', prompt: 'inspect' })
    expect(() => ledger.setRunProcessOwnership(other.id, ownership)).toThrow(/Another run still retains/)
    ledger.patchRun(run.id, { status: 'interrupted' })
    expect(ledger.runsWithProcessOwnership()[0].run.status).toBe('interrupted')
    ledger.updateRunProcessGroupIdentities(run.id, [
      '4243:Thu Sep  3 01:00:01 2026',
      '4244:Thu Sep  3 01:00:02 2026',
    ])
    expect(ledger.runProcessOwnership(run.id)?.groupIdentities).toEqual([
      '4242:Thu Sep  3 01:00:00 2026',
      '4243:Thu Sep  3 01:00:01 2026',
      '4244:Thu Sep  3 01:00:02 2026',
    ])
    expect(() => ledger.updateRunProcessGroupIdentities(run.id, ['5000:Thu Sep  3 02:00:00 2026'])).toThrow(/continuity/)
    expect(() => ledger.updateRunProcessGroupIdentities(run.id, [
      '4243:Thu Sep  3 01:00:01 2026',
      ...Array.from({ length: 256 }, (_, index) => `${5_000 + index}:Thu Sep  3 02:00:00 2026`),
    ])).toThrow(/invalid/)
    ledger.clearRunProcessOwnership(run.id)
    expect(ledger.runProcessOwnership(run.id)).toBeNull()
    expect(ledger.runsWithProcessOwnership()).toEqual([])
    ledger.setRunProcessOwnership(other.id, ownership)
    expect(ledger.runsWithProcessOwnership()[0].run.id).toBe(other.id)
    ledger.clearRunProcessOwnership(other.id)
    ledger.close()
  })

  it('projects the latest role id and exact successful round revision without full run rows', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: workspace(), maxRounds: 2, budgetUsd: null, models })
    const first = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'first' })
    const second = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'second' })
    ledger.patchRun(first.id, { status: 'succeeded', revision: 'a'.repeat(40) })
    ledger.patchRun(second.id, { status: 'succeeded', revision: 'b'.repeat(40) })

    expect(ledger.latestRunIdForRole(loop.id, 'implement')).toBe(second.id)
    expect(ledger.latestRunIdExcept(loop.id, second.id)).toBe(first.id)
    expect(ledger.latestRunIdExcept(loop.id, first.id)).toBe(second.id)
    expect(ledger.hasRunErrorPrefixForWorkspace(loop.workspaceDir, 'UNKNOWN OWNERSHIP')).toBe(false)
    ledger.patchRun(first.id, { error: 'UNKNOWN OWNERSHIP: retained' })
    expect(ledger.hasRunErrorPrefixForWorkspace(loop.workspaceDir, 'UNKNOWN OWNERSHIP')).toBe(true)
    expect(() => ledger.hasRunErrorPrefixForWorkspace(loop.workspaceDir, '')).toThrow(/bounded/)
    expect(ledger.succeededImplementRevision(loop.id, 1)).toBe('b'.repeat(40))
    expect(ledger.succeededImplementRevision(loop.id, 2)).toBeNull()
    ledger.close()
  })

  it('projects the latest critique attempt for every bounded round', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: workspace(), maxRounds: 3, budgetUsd: null, models })
    ledger.createRun({ loopId: loop.id, round: 1, role: 'critique', harness: 'codex', prompt: 'round 1 first' })
    const latest = ledger.createRun({ loopId: loop.id, round: 1, role: 'critique', harness: 'codex', prompt: 'round 1 retry' })
    ledger.createRun({ loopId: loop.id, round: 2, role: 'critique', harness: 'codex', prompt: 'round 2' })
    const projected = ledger.latestRunProjectionPerRound(loop.id, 'critique', 100).runs
    expect(projected.map((run) => [run.round, run.id])).toEqual([[1, latest.id], [2, projected[1].id]])
    expect(projected[1].prompt).toBe('round 2')
    ledger.close()
  })

  it('rejects unsafe per-run accounting values before aggregate projection', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })
    expect(() => ledger.patchRun(run.id, { costUsd: Number.MAX_VALUE })).toThrow(/persisted safety range/)
    expect(() => ledger.patchRun(run.id, { inputTokens: 1_000_000_001 })).toThrow(/persisted safety range/)
    expect(ledger.runAggregate(loop.id)).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 })
    ledger.close()
  })

  it('validates and redacts run provenance before either ledger persists it', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })
    const secret = `ghp_${'c'.repeat(36)}`

    ledger.patchRun(run.id, {
      model: secret,
      cliVersion: `claude ${secret}`,
      costSource: `stream ${secret}`,
      accountLabel: `claude:${secret}`,
      machineLabel: `host-${secret}`,
    })
    expect(ledger.getRun(run.id)).toMatchObject({
      model: '[REDACTED]',
      cliVersion: 'claude [REDACTED]',
      costSource: 'stream [REDACTED]',
      accountLabel: 'claude:[REDACTED]',
      machineLabel: 'host-[REDACTED]',
    })
    expect(() => ledger.patchRun(run.id, { model: 'model with spaces' })).toThrow(/invalid identifier/)
    expect(() => ledger.patchRun(run.id, { effort: 'unbounded' })).toThrow(/effort is invalid/)
    expect(() => ledger.patchRun(run.id, { priceTableVersion: 'latest' })).toThrow(/price-table version is invalid/)
    expect(() => ledger.patchRun(run.id, { promptSha256: 'not-a-hash' })).toThrow(/prompt hash is invalid/)

    const folder = new DatabaseSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(JSON.stringify(folder.prepare('SELECT model, cli_version, cost_source, account_label, machine_label FROM runs WHERE id = ?').get(run.id))).not.toContain(secret)
    folder.close()
    ledger.close()
  })

  it('only persists canonical session ids and nulls malformed legacy values', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })

    ledger.patchRun(run.id, { sessionId: 'session_01-safe' })
    expect(ledger.getRun(run.id)?.sessionId).toBe('session_01-safe')
    expect(() => ledger.patchRun(run.id, { sessionId: '../private/transcript' })).toThrow(/session id has an invalid format/)
    expect(ledger.getRun(run.id)?.sessionId).toBe('session_01-safe')
    ledger.close()

    const dbPath = path.join(dir!, 'ledger.db')
    const raw = new DatabaseSync(dbPath)
    raw.prepare('UPDATE runs SET session_id = ? WHERE id = ?').run('../legacy/private/transcript', run.id)
    raw.close()
    const reopened = new Ledger(dbPath)
    expect(reopened.getRun(run.id)?.sessionId).toBeNull()
    reopened.close()
  })

  it('normalizes safe additive fields and rejects malformed persisted JSON', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })
    ledger.close()
    const dbPath = path.join(dir!, 'ledger.db')
    const raw = new DatabaseSync(dbPath)
    raw.prepare('UPDATE runs SET metrics_json = ? WHERE id = ?').run(
      JSON.stringify({
        agents: [{ id: 'orchestrator', label: 'orchestrator', model: null, messages: 1, tokens: { input: 2, output: 1 }, firstTs: null, lastTs: null }],
        perModel: {},
      }),
      run.id,
    )
    raw.close()
    const reopened = new Ledger(dbPath)
    expect(reopened.getRun(run.id)?.metrics?.agents[0].tokens).toEqual({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 })
    reopened.close()

    const malformed = new DatabaseSync(dbPath)
    malformed.prepare('UPDATE runs SET verdict_json = ? WHERE id = ?').run(
      JSON.stringify({ score: '0.9', pass: true, summary: 'coercion must fail', findings: [] }),
      run.id,
    )
    malformed.close()
    const invalid = new Ledger(dbPath)
    expect(() => invalid.getRun(run.id)).toThrow(/verdict contract/)
    invalid.close()
  })

  it('canonicalizes workspace aliases so one mirror retains every loop', () => {
    const ledger = makeLedger()
    const real = workspace('real-project')
    const alias = path.join(dir!, 'project-alias')
    fs.symlinkSync(real, alias)
    const first = ledger.createLoop({ prompt: 'first', workspaceDir: real, maxRounds: 1, budgetUsd: null, models })
    const second = ledger.createLoop({ prompt: 'second', workspaceDir: alias, maxRounds: 1, budgetUsd: null, models })

    expect(ledger.getLoop(second.id)?.workspaceDir).toBe(fs.realpathSync(real))
    ledger.prepareRunFolder(second.id)
    const folder = new DatabaseSync(path.join(real, '.gauntlet-gamesmith', 'ledger.db'), { readOnly: true })
    expect(folder.prepare('SELECT id FROM loops ORDER BY created_at, rowid').all()).toEqual([{ id: first.id }, { id: second.id }])
    folder.close()
    ledger.close()
  })

  it('rejects a planted metadata-directory symlink before creating a registry loop', () => {
    const ledger = makeLedger()
    const project = workspace('symlink-project')
    const outside = workspace('outside-metadata')
    fs.symlinkSync(outside, path.join(project, '.gauntlet-gamesmith'))

    expect(() =>
      ledger.createLoop({ prompt: 'must not escape', workspaceDir: project, maxRounds: 1, budgetUsd: null, models }),
    ).toThrow(/must be a real directory/)
    expect(ledger.loops()).toEqual([])
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
      ledger.createLoop({ prompt: 'must not open sidecar', workspaceDir: project, maxRounds: 1, budgetUsd: null, models }),
    ).toThrow(/must be an unlinked regular file/)
    expect(ledger.loops()).toEqual([])
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
      ledger.createLoop({ prompt: 'must not open hard link', workspaceDir: project, maxRounds: 1, budgetUsd: null, models }),
    ).toThrow(/must be an unlinked regular file/)
    expect(ledger.loops()).toEqual([])
    expect(fs.readFileSync(outside, 'utf8')).toBe('preserve')
    ledger.close()
  })
})

describe('Ledger deletion and report storage', () => {
  it('forgets a run without touching the folder ledger, so it can be imported back', () => {
    const ledger = makeLedger()
    const workspaceDir = workspace('deletable')
    const loop = ledger.createLoop({ prompt: 'build it', workspaceDir, maxRounds: 5, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'do it' })
    ledger.appendEvent({ loopId: loop.id, runId: run.id, ts: new Date().toISOString(), kind: 'system', text: 'started' })
    ledger.prepareRunFolder(loop.id)

    expect(ledger.deleteLoop(loop.id)).toBe(true)
    expect(ledger.getLoop(loop.id)).toBeNull()
    expect(ledger.runsForLoop(loop.id)).toEqual([])
    expect(ledger.eventsForLoop(loop.id)).toEqual([])
    expect(fs.existsSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db'))).toBe(true)

    const [reimported] = ledger.importRunFolder(workspaceDir)
    expect(reimported.loop.id).toBe(loop.id)
    expect(reimported.runs).toHaveLength(1)
  })

  it('says so when the run was already gone', () => {
    expect(makeLedger().deleteLoop('nope')).toBe(false)
  })

  it('lists the runs sharing a project folder', () => {
    const ledger = makeLedger()
    const shared = workspace('shared')
    const first = ledger.createLoop({ prompt: 'one', workspaceDir: shared, maxRounds: 2, budgetUsd: null, models })
    const second = ledger.createLoop({ prompt: 'two', workspaceDir: shared, maxRounds: 2, budgetUsd: null, models })
    ledger.createLoop({ prompt: 'three', workspaceDir: workspace('other'), maxRounds: 2, budgetUsd: null, models })
    expect(ledger.loopsInWorkspace(shared).map((loop) => loop.id).sort()).toEqual([first.id, second.id].sort())
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
