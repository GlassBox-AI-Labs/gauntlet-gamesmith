import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { Ledger } from './ledger'
import {
  assertDeletableRunFolder,
  assertExportDestination,
  assertRunFolder,
  canonicalizePath,
  copyRunFolder,
  deleteRunFolder,
  exportActivityError,
  LEGACY_RUN_METADATA_DIR,
  MAX_IMPORTED_LEDGER_BYTES,
  migrateRunMetadataDir,
  nextAvailableExportPath,
  RAW_EXPORT_WARNING,
  RUN_METADATA_DIR,
  runLedgerPath,
  safeExportFolderName,
  snapshotRunLedger,
} from './run-transfer'

const MODELS = resolveModels(
  { orchestratorModel: 'claude-fable-5', orchestratorEffort: 'high', subagentModel: 'claude-opus-5', subagentEffort: 'medium' },
  DEFAULT_CRITIC,
)

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-folder-transfer-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('run folder transfer', () => {
  it('warns that complete raw stream evidence is intentionally unsanitized', () => {
    expect(RAW_EXPORT_WARNING).toMatch(/unsanitized raw CLI streams/)
    expect(RAW_EXPORT_WARNING).toMatch(/review them before sharing/)
  })
  it('requires both the agent loop and Play process to stop before an exact export', () => {
    expect(exportActivityError(true, false)).toMatch(/Stop the run/)
    expect(exportActivityError(false, true)).toMatch(/Stop the running game/)
    expect(exportActivityError(false, false)).toBeNull()
  })
  it('keeps an exact SQLite mirror inside the project folder', () => {
    const root = tempDir()
    const workspace = path.join(root, 'project')
    fs.mkdirSync(workspace)
    const ledger = new Ledger(path.join(root, 'app-ledger.db'))
    const loop = ledger.createLoop({ prompt: 'Build the game', workspaceDir: workspace, maxRounds: 4, budgetUsd: 20, models: MODELS })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'Implement it' })
    const finishedAt = new Date().toISOString()
    ledger.patchRun(run.id, { status: 'succeeded', inputTokens: 12, outputTokens: 8, finishedAt })
    ledger.appendEvent({ loopId: loop.id, runId: run.id, ts: finishedAt, kind: 'done', text: 'Finished exactly once' })
    ledger.prepareRunFolder(loop.id)

    const folderDb = new DatabaseSync(runLedgerPath(workspace), { readOnly: true })
    const mirroredLoop = folderDb.prepare('SELECT * FROM loops WHERE id = ?').get(loop.id) as Record<string, unknown>
    const mirroredRun = folderDb.prepare('SELECT * FROM runs WHERE id = ?').get(run.id) as Record<string, unknown>
    const mirroredEvent = folderDb.prepare('SELECT * FROM events WHERE loop_id = ?').get(loop.id) as Record<string, unknown>
    expect(mirroredLoop).toMatchObject({ id: loop.id, workspace_dir: fs.realpathSync(workspace), prompt: 'Build the game' })
    expect(mirroredRun).toMatchObject({ id: run.id, loop_id: loop.id, status: 'succeeded', finished_at: finishedAt })
    expect(mirroredEvent).toMatchObject({ loop_id: loop.id, run_id: run.id, kind: 'done', text: 'Finished exactly once' })
    folderDb.close()
    ledger.close()
  })

  it('copies the whole project and imports its history without remapping IDs', async () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source-project')
    fs.mkdirSync(path.join(sourceWorkspace, 'reference', 'images'), { recursive: true })
    fs.mkdirSync(path.join(sourceWorkspace, 'critique', 'round-1', 'shots'), { recursive: true })
    fs.writeFileSync(path.join(sourceWorkspace, 'game.ts'), 'export const game = true\n')
    fs.writeFileSync(path.join(sourceWorkspace, 'reference', 'images', 'reference.txt'), 'downloaded reference')
    fs.writeFileSync(path.join(sourceWorkspace, 'critique', 'round-1', 'shots', 'frame.txt'), 'captured frame')

    const source = new Ledger(path.join(root, 'source-app.db'))
    const sourceLoop = source.createLoop({ prompt: 'Build the game', workspaceDir: sourceWorkspace, maxRounds: 4, budgetUsd: null, models: MODELS })
    const sourceRun = source.createRun({ loopId: sourceLoop.id, round: 1, role: 'critique', harness: 'codex', prompt: 'Judge it' })
    const eventTs = new Date().toISOString()
    source.patchRun(sourceRun.id, {
      status: 'succeeded',
      verdict: { score: 0.72, pass: false, summary: 'Keep going', findings: [{ severity: 'major', text: 'More polish' }] },
      finishedAt: eventTs,
    })
    source.appendEvent({ loopId: sourceLoop.id, runId: sourceRun.id, ts: eventTs, kind: 'verdict', text: 'Score 0.72' })
    source.prepareRunFolder(sourceLoop.id)
    source.close()

    const exportedWorkspace = path.join(root, 'shared', 'source-project-gauntlet-run')
    await copyRunFolder(sourceWorkspace, exportedWorkspace)
    expect(fs.readFileSync(path.join(exportedWorkspace, 'game.ts'), 'utf8')).toBe('export const game = true\n')
    expect(fs.readFileSync(path.join(exportedWorkspace, 'reference', 'images', 'reference.txt'), 'utf8')).toBe('downloaded reference')
    expect(fs.readFileSync(path.join(exportedWorkspace, 'critique', 'round-1', 'shots', 'frame.txt'), 'utf8')).toBe('captured frame')
    expect(fs.existsSync(runLedgerPath(exportedWorkspace))).toBe(true)

    const target = new Ledger(path.join(root, 'target-app.db'))
    const imported = target.importRunFolder(exportedWorkspace)
    expect(imported).toHaveLength(1)
    expect(imported[0].loop.id).toBe(sourceLoop.id)
    expect(imported[0].loop.createdAt).toBe(sourceLoop.createdAt)
    expect(imported[0].loop.workspaceDir).toBe(fs.realpathSync(exportedWorkspace))
    expect(imported[0].loop.status).toBe('stopped')
    expect(imported[0].loop.playTrusted).toBe(false)
    expect(imported[0].runs[0]).toMatchObject({ id: sourceRun.id, loopId: sourceLoop.id, finishedAt: eventTs })
    expect(target.eventsForLoop(sourceLoop.id)).toEqual([
      // round/role/channel come from the read-time backfill for legacy rows.
      { loopId: sourceLoop.id, runId: sourceRun.id, ts: eventTs, kind: 'verdict', channel: 'output', round: 1, role: 'critique', text: 'Score 0.72' },
    ])
    target.appendEvent({ loopId: sourceLoop.id, runId: sourceRun.id, ts: eventTs, kind: 'done', text: 'Continued on teammate machine' })

    const importedFolderDb = new DatabaseSync(runLedgerPath(exportedWorkspace), { readOnly: true })
    expect(importedFolderDb.prepare('SELECT workspace_dir FROM loops WHERE id = ?').get(sourceLoop.id)).toEqual({ workspace_dir: fs.realpathSync(exportedWorkspace) })
    expect(importedFolderDb.prepare('SELECT seq, text FROM events ORDER BY seq').all()).toEqual([
      { seq: 1, text: 'Score 0.72' },
      { seq: 2, text: 'Continued on teammate machine' },
    ])
    importedFolderDb.close()
    const [reimported] = target.importRunFolder(exportedWorkspace)
    expect(reimported.loop.id).toBe(sourceLoop.id)
    expect(target.eventsForLoop(sourceLoop.id).map((event) => event.text)).toEqual([
      'Score 0.72',
      'Continued on teammate machine',
    ])
    target.close()
  })

  it('never overwrites an unregistered portable ledger when starting in an exported workspace', () => {
    const root = tempDir()
    const workspace = path.join(root, 'portable-project')
    fs.mkdirSync(workspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const sourceLoop = source.createLoop({ prompt: 'portable history', workspaceDir: workspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.createRun({ loopId: sourceLoop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'preserve me' })
    source.prepareRunFolder(sourceLoop.id)
    source.close()
    const portablePath = runLedgerPath(workspace)
    const before = fs.readFileSync(portablePath)

    const unrelated = new Ledger(path.join(root, 'unrelated.db'))
    expect(() => unrelated.createLoop({ prompt: 'new history', workspaceDir: workspace, maxRounds: 1, budgetUsd: null, models: MODELS }))
      .toThrow(/Import its history/)
    expect(fs.readFileSync(portablePath)).toEqual(before)
    unrelated.close()
  })

  it('downgrades imported queued and running attempts instead of recovering untrusted process metadata', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const loop = source.createLoop({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 2, budgetUsd: null, models: MODELS })
    const queued = source.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'queued' })
    const running = source.createRun({ loopId: loop.id, round: 1, role: 'critique', harness: 'codex', prompt: 'running' })
    source.patchRun(running.id, { status: 'running' })
    source.setRunProcessOwnership(running.id, {
      pid: 4242,
      processIdentity: 'Thu Sep  3 01:00:00 2026',
      groupIdentities: ['4242:Thu Sep  3 01:00:00 2026'],
      startedAtMs: 1_788_399_600_000,
      outDev: 1,
      outIno: 2,
      errDev: 1,
      errIno: 3,
    })
    source.prepareRunFolder(loop.id)
    source.close()

    const target = new Ledger(path.join(root, 'target.db'))
    const [snapshot] = target.importRunFolder(sourceWorkspace)

    expect(snapshot.loop).toMatchObject({ status: 'stopped', playTrusted: false })
    expect(snapshot.runs.find((run) => run.id === queued.id)).toMatchObject({ status: 'interrupted' })
    expect(snapshot.runs.find((run) => run.id === running.id)).toMatchObject({ status: 'interrupted' })
    expect(target.runProcessOwnership(running.id)).toBeNull()
    const folder = new DatabaseSync(runLedgerPath(sourceWorkspace), { readOnly: true })
    expect(folder.prepare('SELECT play_trusted, status FROM loops WHERE id = ?').get(loop.id)).toEqual({ play_trusted: 0, status: 'stopped' })
    expect(folder.prepare('SELECT status FROM runs ORDER BY created_at, rowid').all()).toEqual([{ status: 'interrupted' }, { status: 'interrupted' }])
    folder.close()
    target.close()
  })

  it('compensates the registry without overwriting entries that raced mirror publication', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source-crash-order')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source-crash-order.db'))
    const loop = source.createLoop({ prompt: 'portable source', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.prepareRunFolder(loop.id)
    source.close()
    const portablePath = runLedgerPath(sourceWorkspace)
    const journalPath = `${portablePath}-journal`
    expect(fs.existsSync(journalPath)).toBe(false)

    const targetPath = path.join(root, 'target-crash-order.db')
    const target = new Ledger(targetPath)
    const internal = target as unknown as { publishWorkspaceFolderAtomically(workspaceDir: string): void }
    internal.publishWorkspaceFolderAtomically = () => {
      fs.unlinkSync(portablePath)
      fs.writeFileSync(portablePath, 'partial replacement')
      fs.writeFileSync(journalPath, 'partial sidecar')
      throw new Error('synthetic crash during mirror rewrite')
    }
    expect(() => target.importRunFolder(sourceWorkspace)).toThrow(/synthetic crash.*could not be restored/i)
    expect(target.getLoop(loop.id)).toBeNull()
    expect(fs.readFileSync(portablePath, 'utf8')).toBe('partial replacement')
    expect(fs.readFileSync(journalPath, 'utf8')).toBe('partial sidecar')
    target.close()

    const reopened = new Ledger(targetPath)
    expect(reopened.getLoop(loop.id)).toBeNull()
    reopened.close()
  })

  it('restores the selected portable source when normalized publication fails after publish', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source-post-publish')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source-post-publish.db'))
    const loop = source.createLoop({ prompt: 'exact source', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.prepareRunFolder(loop.id)
    source.close()
    const metadataDir = fs.realpathSync(path.dirname(runLedgerPath(sourceWorkspace)))
    const originalOpen = fs.openSync.bind(fs)
    const open = vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(target) === metadataDir) throw new Error('synthetic post-publish directory fsync failure')
      return originalOpen(target, flags, mode)
    }) as typeof fs.openSync)
    const target = new Ledger(path.join(root, 'target-post-publish.db'))

    try {
      expect(() => target.importRunFolder(sourceWorkspace)).toThrow(/post-publish directory fsync failure/)
      expect(target.getLoop(loop.id)).toBeNull()
      const restored = new DatabaseSync(runLedgerPath(sourceWorkspace), { readOnly: true })
      expect(restored.prepare('SELECT prompt FROM loops WHERE id = ?').get(loop.id)).toEqual({ prompt: 'exact source' })
      restored.close()
    } finally {
      open.mockRestore()
      target.close()
    }
  })

  it('rejects active and inactive trusted same-workspace imports without laundering mirror changes', () => {
    const root = tempDir()
    const localWorkspace = path.join(root, 'local-active')
    fs.mkdirSync(localWorkspace)
    const ledger = new Ledger(path.join(root, 'local-active.db'))
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: localWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'build' })
    ledger.patchRun(run.id, { status: 'running' })
    ledger.prepareRunFolder(loop.id)

    expect(() => ledger.importRunFolder(localWorkspace)).toThrow(/while one of its local runs is active/)
    expect(ledger.getLoop(loop.id)).toMatchObject({ status: 'running', playTrusted: true })
    expect(ledger.getRun(run.id)?.status).toBe('running')
    const unchanged = new DatabaseSync(runLedgerPath(localWorkspace), { readOnly: true })
    expect(unchanged.prepare('SELECT status, play_trusted FROM loops WHERE id = ?').get(loop.id)).toEqual({ status: 'running', play_trusted: 1 })
    unchanged.close()

    ledger.transaction(() => {
      ledger.patchRun(run.id, { status: 'interrupted' })
      ledger.patchLoop(loop.id, { status: 'stopped' })
    })
    const tampered = new DatabaseSync(runLedgerPath(localWorkspace))
    tampered.prepare('UPDATE runs SET prompt = ?, session_id = ? WHERE id = ?').run('execute mirror payload', 'attacker_session', run.id)
    tampered.close()

    expect(() => ledger.importRunFolder(localWorkspace)).toThrow(/already registered as trusted local history/)
    expect(ledger.getLoop(loop.id)).toMatchObject({ status: 'stopped', playTrusted: true })
    expect(ledger.getRun(run.id)).toMatchObject({ prompt: 'build', sessionId: null })
    const stillTampered = new DatabaseSync(runLedgerPath(localWorkspace), { readOnly: true })
    expect(stillTampered.prepare('SELECT prompt, session_id FROM runs WHERE id = ?').get(run.id)).toEqual({
      prompt: 'execute mirror payload',
      session_id: 'attacker_session',
    })
    stillTampered.close()
    ledger.close()
  })

  it('validates all JSON before mutating or registering an imported folder', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const loop = source.createLoop({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    const run = source.createRun({ loopId: loop.id, round: 1, role: 'critique', harness: 'codex', prompt: 'judge' })
    source.prepareRunFolder(loop.id)
    source.close()
    const folder = new DatabaseSync(runLedgerPath(sourceWorkspace))
    folder.prepare('UPDATE runs SET verdict_json = ? WHERE id = ?').run(
      JSON.stringify({ score: '0.9', pass: true, summary: 'invalid', findings: [] }),
      run.id,
    )
    folder.close()

    const target = new Ledger(path.join(root, 'target.db'))
    expect(() => target.importRunFolder(sourceWorkspace)).toThrow(/verdict contract/)
    expect(target.loops()).toEqual([])
    const unchanged = new DatabaseSync(runLedgerPath(sourceWorkspace), { readOnly: true })
    expect(unchanged.prepare('SELECT workspace_dir, play_trusted, status FROM loops WHERE id = ?').get(loop.id)).toEqual({
      workspace_dir: fs.realpathSync(sourceWorkspace),
      play_trusted: 1,
      status: 'running',
    })
    unchanged.close()
    target.close()
  })

  it('rejects an imported session id that could address a private-home path', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source-session')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source-session.db'))
    const loop = source.createLoop({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    const run = source.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'build' })
    source.prepareRunFolder(loop.id)
    source.close()
    const folder = new DatabaseSync(runLedgerPath(sourceWorkspace))
    folder.prepare('UPDATE runs SET session_id = ? WHERE id = ?').run('../../private/session', run.id)
    folder.close()

    const target = new Ledger(path.join(root, 'target-session.db'))
    expect(() => target.importRunFolder(sourceWorkspace)).toThrow(/invalid session id/)
    expect(target.loops()).toEqual([])
    target.close()
  })

  it('rewrites imported structured strings redacted while preserving accounting values', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source-redaction')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source-redaction.db'))
    const loop = source.createLoop({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    const run = source.createRun({ loopId: loop.id, round: 1, role: 'critique', harness: 'codex', prompt: 'judge' })
    source.appendEvent({ loopId: loop.id, runId: run.id, ts: '2026-01-01T00:00:00.000Z', kind: 'system', text: 'safe' })
    source.prepareRunFolder(loop.id)
    source.close()
    const secret = `ghp_${'a'.repeat(36)}`
    const folder = new DatabaseSync(runLedgerPath(sourceWorkspace))
    folder.prepare('UPDATE events SET text = ?').run(`event ${secret}`)
    folder.prepare('UPDATE loops SET models_json = ? WHERE id = ?').run(JSON.stringify({
      ...MODELS,
      orchestratorModel: `gpt-${secret}`,
      subagentModel: `claude-${secret}`,
    }), loop.id)
    folder.prepare('UPDATE runs SET verdict_json = ?, metrics_json = ?, model = ?, cli_version = ?, cost_source = ?, account_label = ?, machine_label = ? WHERE id = ?').run(
      JSON.stringify({ score: 0.5, pass: false, summary: `summary ${secret}`, findings: [{ severity: 'major', text: `finding ${secret}` }] }),
      JSON.stringify({
        agents: [{
          id: 'child:worker', label: `worker ${secret}`, model: secret, messages: 2,
          tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 }, firstTs: null, lastTs: null,
          prompt: `prompt ${secret}`, note: `note ${secret}`, lastTool: `tool ${secret}`, costUsd: 0.5,
        }],
        perModel: { [secret]: { costUsd: 0.5, tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 } } },
      }),
      secret,
      `codex ${secret}`,
      `rate ${secret}`,
      `codex:${secret}`,
      `host-${secret}`,
      run.id,
    )
    folder.close()

    const target = new Ledger(path.join(root, 'target-redaction.db'))
    const [snapshot] = target.importRunFolder(sourceWorkspace)
    expect(target.eventsForLoop(loop.id)[0].text).toBe('event [REDACTED]')
    expect(snapshot.runs[0].verdict).toEqual({
      score: 0.5,
      pass: false,
      summary: 'summary [REDACTED]',
      findings: [{ severity: 'major', text: 'finding [REDACTED]' }],
    })
    expect(snapshot.runs[0].metrics?.agents[0]).toEqual(expect.objectContaining({
      label: 'worker [REDACTED]', prompt: 'prompt [REDACTED]', note: 'note [REDACTED]', lastTool: 'tool [REDACTED]',
      model: '[REDACTED]', messages: 2, tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 }, costUsd: 0.5,
    }))
    expect(snapshot.runs[0]).toMatchObject({
      model: '[REDACTED]', cliVersion: 'codex [REDACTED]', costSource: 'rate [REDACTED]',
      accountLabel: 'codex:[REDACTED]', machineLabel: 'host-[REDACTED]',
    })
    expect(snapshot.runs[0].metrics?.perModel['[REDACTED]']).toEqual({
      costUsd: 0.5, tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 },
    })
    expect(snapshot.loop.models.orchestratorModel).toBe('claude-opus-5')
    expect(snapshot.loop.models.subagentModel).toBe('claude-opus-5')
    expect(JSON.stringify(snapshot.loop.models)).not.toContain(secret)
    const rewritten = new DatabaseSync(runLedgerPath(sourceWorkspace), { readOnly: true })
    expect(rewritten.prepare('SELECT text FROM events').get()).toEqual({ text: 'event [REDACTED]' })
    const persistedRun = rewritten.prepare('SELECT verdict_json, metrics_json, model, cli_version, cost_source, account_label, machine_label FROM runs WHERE id = ?').get(run.id) as {
      verdict_json: string
      metrics_json: string
      model: string
      cli_version: string
      cost_source: string
      account_label: string
      machine_label: string
    }
    expect(JSON.stringify(persistedRun)).not.toContain(secret)
    rewritten.close()
    target.close()
  })

  it.each([
    ['loops', 'created_at'],
    ['runs', 'created_at'],
    ['events', 'ts'],
  ] as const)('rejects a malformed imported %s.%s timestamp', (table, column) => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const loop = source.createLoop({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    const run = source.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'build' })
    source.appendEvent({ loopId: loop.id, runId: run.id, ts: new Date().toISOString(), kind: 'system', text: 'event' })
    source.prepareRunFolder(loop.id)
    source.close()
    const folder = new DatabaseSync(runLedgerPath(sourceWorkspace))
    folder.exec(`UPDATE ${table} SET ${column} = 'not-a-date'`)
    folder.close()

    const target = new Ledger(path.join(root, 'target.db'))
    expect(() => target.importRunFolder(sourceWorkspace)).toThrow(/canonical ISO timestamp/)
    expect(target.loops()).toEqual([])
    target.close()
  })

  it('rejects a transferred expression index even when it reuses an expected index name', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const loop = source.createLoop({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'build' })
    source.prepareRunFolder(loop.id)
    source.close()
    const folder = new DatabaseSync(runLedgerPath(sourceWorkspace))
    folder.exec('DROP INDEX idx_runs_loop; CREATE INDEX idx_runs_loop ON runs(substr(prompt, 1, 1));')
    folder.close()

    const target = new Ledger(path.join(root, 'target.db'))
    expect(() => target.importRunFolder(sourceWorkspace)).toThrow(/unsupported index definition/)
    expect(target.loops()).toEqual([])
    target.close()
  })

  it('rejects an allowed-column schema whose identity primary key was removed', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const loop = source.createLoop({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'build' })
    source.prepareRunFolder(loop.id)
    source.close()
    const folder = new DatabaseSync(runLedgerPath(sourceWorkspace))
    folder.exec(`
      DROP INDEX idx_runs_loop;
      CREATE TABLE runs_without_pk AS SELECT * FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_without_pk RENAME TO runs;
      INSERT INTO runs SELECT * FROM runs;
      CREATE INDEX idx_runs_loop ON runs(loop_id, created_at);
    `)
    folder.close()

    const target = new Ledger(path.join(root, 'target.db'))
    expect(() => target.importRunFolder(sourceWorkspace)).toThrow(/runs\.id primary-key constraint is missing/)
    expect(target.loops()).toEqual([])
    target.close()
  })

  it('rejects virtual generated columns before integrity checks or row materialization', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source-generated')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source-generated.db'))
    const loop = source.createLoop({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'build' })
    source.prepareRunFolder(loop.id)
    source.close()
    const folder = new DatabaseSync(runLedgerPath(sourceWorkspace))
    folder.exec('ALTER TABLE runs ADD COLUMN expansion BLOB GENERATED ALWAYS AS (zeroblob(268435456)) VIRTUAL')
    folder.close()

    const target = new Ledger(path.join(root, 'target-generated.db'))
    expect(() => target.importRunFolder(sourceWorkspace)).toThrow(/generated or hidden columns/)
    expect(target.loops()).toEqual([])
    target.close()
  })

  it('rejects forged non-UUID record ids before mutating or registering an import', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const loop = source.createLoop({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.prepareRunFolder(loop.id)
    source.close()
    const folder = new DatabaseSync(runLedgerPath(sourceWorkspace))
    folder.prepare('UPDATE loops SET id = ? WHERE id = ?').run('forged:loop', loop.id)
    folder.close()

    const target = new Ledger(path.join(root, 'target.db'))
    expect(() => target.importRunFolder(sourceWorkspace)).toThrow(/Loop id has an invalid format/)
    expect(target.loops()).toEqual([])
    const unchanged = new DatabaseSync(runLedgerPath(sourceWorkspace), { readOnly: true })
    expect(unchanged.prepare('SELECT id, play_trusted, status FROM loops').get()).toEqual({
      id: 'forged:loop',
      play_trusted: 1,
      status: 'running',
    })
    unchanged.close()
    target.close()
  })

  it('rejects a loop UUID collision without replacing history from another workspace', () => {
    const root = tempDir()
    const localWorkspace = path.join(root, 'local')
    const transferWorkspace = path.join(root, 'transfer')
    fs.mkdirSync(localWorkspace)
    fs.mkdirSync(transferWorkspace)

    const target = new Ledger(path.join(root, 'target.db'))
    const localLoop = target.createLoop({ prompt: 'local history', workspaceDir: localWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    const localRun = target.createRun({ loopId: localLoop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'keep me' })
    target.appendEvent({ loopId: localLoop.id, runId: localRun.id, ts: '2026-01-01T00:00:00.000Z', kind: 'system', text: 'preserve me' })

    const source = new Ledger(path.join(root, 'source.db'))
    const transferLoop = source.createLoop({ prompt: 'transferred history', workspaceDir: transferWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.prepareRunFolder(transferLoop.id)
    source.close()
    const folder = new DatabaseSync(runLedgerPath(transferWorkspace))
    folder.prepare('UPDATE loops SET id = ? WHERE id = ?').run(localLoop.id, transferLoop.id)
    folder.close()

    expect(() => target.importRunFolder(transferWorkspace)).toThrow(/collides with history owned by another workspace/)
    expect(target.getLoop(localLoop.id)).toMatchObject({ prompt: 'local history', workspaceDir: fs.realpathSync(localWorkspace) })
    expect(target.getRun(localRun.id)).toMatchObject({ prompt: 'keep me' })
    expect(target.eventsForLoop(localLoop.id).map((event) => event.text)).toEqual(['preserve me'])
    target.close()
  })

  it('repairs a stale folder mirror before returning an export snapshot', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const loop = source.createLoop({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.appendEvent({ loopId: loop.id, runId: null, ts: '2026-01-01T00:00:00.000Z', kind: 'system', text: 'must survive export' })
    const stale = new DatabaseSync(runLedgerPath(sourceWorkspace))
    stale.exec('DELETE FROM events')
    stale.close()

    source.prepareRunFolder(loop.id)

    const repaired = new DatabaseSync(runLedgerPath(sourceWorkspace), { readOnly: true })
    expect(repaired.prepare('SELECT text FROM events').all()).toEqual([{ text: 'must survive export' }])
    repaired.close()
    source.close()
  })

  it('migrates and imports a project-folder ledger from the previous schema', () => {
    const root = tempDir()
    const workspace = path.join(root, 'legacy-project')
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    const legacy = new DatabaseSync(runLedgerPath(workspace))
    legacy.exec(`
      CREATE TABLE loops (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, workspace_dir TEXT NOT NULL, max_rounds INTEGER NOT NULL,
        budget_usd REAL, models_json TEXT NOT NULL, status TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0, stop_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, loop_id TEXT NOT NULL, round INTEGER NOT NULL, role TEXT NOT NULL, harness TEXT NOT NULL,
        status TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT, summary TEXT, verdict_json TEXT, metrics_json TEXT,
        cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, num_turns INTEGER, duration_ms INTEGER,
        session_id TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, loop_id TEXT NOT NULL, run_id TEXT, ts TEXT NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL
      );
    `)
    legacy.prepare(
      `INSERT INTO loops
       (id, prompt, workspace_dir, max_rounds, models_json, status, round, total_cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'stopped', 1, 0, ?, ?)`,
    ).run('11111111-1111-4111-8111-111111111111', 'old', workspace, 1, JSON.stringify(MODELS), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    legacy.prepare(
      `INSERT INTO runs (id, loop_id, round, role, harness, status, prompt, created_at)
       VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 1, 'implement', 'claude', 'succeeded', 'go', '2026-01-01T00:00:00.000Z')`,
    ).run()
    legacy.prepare(
      `INSERT INTO events (loop_id, run_id, ts, kind, text)
       VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '2026-01-01T00:00:00.000Z', 'done', 'complete')`,
    ).run()
    legacy.close()

    const target = new Ledger(path.join(root, 'target.db'))
    const [snapshot] = target.importRunFolder(workspace)
    expect(snapshot).toMatchObject({
      loop: { id: '11111111-1111-4111-8111-111111111111', playTrusted: false },
      runs: [{ id: '22222222-2222-4222-8222-222222222222', revision: null }],
    })
    target.close()

    const migrated = new DatabaseSync(runLedgerPath(workspace), { readOnly: true })
    const names = (table: string): string[] =>
      (migrated.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((column) => column.name)
    expect(names('loops')).toEqual(expect.arrayContaining(['title', 'play_trusted']))
    expect(names('runs')).toEqual(
      expect.arrayContaining(['revision', 'effort', 'cli_version', 'price_table_version', 'cost_source', 'process_ownership_json']),
    )
    expect(names('events')).toEqual(expect.arrayContaining(['agent_id', 'round', 'role', 'channel']))
    migrated.close()
  })

  it('chooses stable folder names and refuses recursive exports', () => {
    const root = tempDir()
    const source = path.join(root, 'My Project')
    const parent = path.join(root, 'exports')
    fs.mkdirSync(source)
    fs.mkdirSync(parent)
    expect(safeExportFolderName('My Project')).toBe('My-Project-gauntlet-run')
    expect(nextAvailableExportPath(parent, 'My-Project-gauntlet-run')).toBe(path.join(parent, 'My-Project-gauntlet-run'))
    fs.mkdirSync(path.join(parent, 'My-Project-gauntlet-run'))
    expect(nextAvailableExportPath(parent, 'My-Project-gauntlet-run')).toBe(path.join(parent, 'My-Project-gauntlet-run-2'))
    expect(() => assertExportDestination(source, path.join(source, 'exports', 'copy'))).toThrow(/outside the project folder/)
  })

  it('canonicalizes aliases through their nearest existing ancestor', () => {
    const root = tempDir()
    const real = path.join(root, 'real')
    const alias = path.join(root, 'alias')
    fs.mkdirSync(real)
    fs.symlinkSync(real, alias)

    expect(canonicalizePath(path.join(alias, 'future', 'folder'))).toBe(path.join(fs.realpathSync(real), 'future', 'folder'))
    expect(() => canonicalizePath('relative/folder')).toThrow(/absolute/)
  })

  it('does not remove a destination another process already created', async () => {
    const root = tempDir()
    const source = path.join(root, 'source')
    const destination = path.join(root, 'destination')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'source.txt'), 'source')
    fs.mkdirSync(destination)
    fs.writeFileSync(path.join(destination, 'owned-by-someone-else.txt'), 'keep')

    await expect(copyRunFolder(source, destination)).rejects.toThrow()
    expect(fs.readFileSync(path.join(destination, 'owned-by-someone-else.txt'), 'utf8')).toBe('keep')
  })

  it('leaves the uniquely claimed partial destination when copying fails', async () => {
    const root = tempDir()
    const source = path.join(root, 'source')
    const destination = path.join(root, 'destination')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'source.txt'), 'source')
    const copy = vi.spyOn(fs.promises, 'cp').mockRejectedValueOnce(new Error('simulated copy failure'))
    try {
      await expect(copyRunFolder(source, destination)).rejects.toThrow(/simulated copy failure/)
      expect(fs.lstatSync(destination).isDirectory()).toBe(true)
    } finally {
      copy.mockRestore()
    }
  })

  it('preserves a replacement directory planted after the export path was claimed', async () => {
    const root = tempDir()
    const source = path.join(root, 'source')
    const destination = path.join(root, 'destination')
    const displaced = path.join(root, 'displaced-app-destination')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'source.txt'), 'source')
    const copy = vi.spyOn(fs.promises, 'cp').mockImplementationOnce(async () => {
      fs.renameSync(destination, displaced)
      fs.mkdirSync(destination)
      fs.writeFileSync(path.join(destination, 'operator.txt'), 'must survive rollback')
      throw new Error('simulated copy failure after replacement')
    })
    try {
      await expect(copyRunFolder(source, destination)).rejects.toThrow(/after replacement/)
      expect(fs.readFileSync(path.join(destination, 'operator.txt'), 'utf8')).toBe('must survive rollback')
      expect(fs.lstatSync(displaced).isDirectory()).toBe(true)
    } finally {
      copy.mockRestore()
    }
  })

  it('stops before another copy when the claimed destination changes identity', async () => {
    const root = tempDir()
    const source = path.join(root, 'source')
    const destination = path.join(root, 'destination')
    const displaced = path.join(root, 'displaced-app-destination')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(source)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(source, 'a.txt'), 'a')
    fs.writeFileSync(path.join(source, 'b.txt'), 'b')
    const copy = vi.spyOn(fs.promises, 'cp').mockImplementationOnce(async () => {
      fs.renameSync(destination, displaced)
      fs.symlinkSync(outside, destination)
    })
    try {
      await expect(copyRunFolder(source, destination)).rejects.toThrow(/destination changed identity/)
      expect(copy).toHaveBeenCalledTimes(1)
      expect(fs.readdirSync(outside)).toEqual([])
      expect(fs.lstatSync(displaced).isDirectory()).toBe(true)
    } finally {
      copy.mockRestore()
    }
  })

  it('requires the export source to match its canonical ledger identity', async () => {
    const root = tempDir()
    const source = path.join(root, 'source')
    const destination = path.join(root, 'destination')
    fs.mkdirSync(source)
    const stat = fs.lstatSync(source)

    await expect(copyRunFolder(source, destination, { dev: stat.dev, ino: stat.ino + 1 })).rejects.toThrow(/canonical workspace identity/)
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('rejects a folder ledger symlink', () => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    const outside = path.join(root, 'outside.db')
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    fs.writeFileSync(outside, 'not really sqlite')
    fs.symlinkSync(outside, runLedgerPath(workspace))

    expect(() => assertRunFolder(workspace)).toThrow(/regular file, not a symlink/)
  })

  it.each(['-wal', '-journal'])('rejects an untrusted SQLite %s sidecar symlink before opening the database', (suffix) => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    const ledgerPath = runLedgerPath(workspace)
    fs.writeFileSync(ledgerPath, 'sqlite placeholder')
    const outside = path.join(root, `outside${suffix}`)
    fs.writeFileSync(outside, 'must not be opened')
    fs.symlinkSync(outside, `${ledgerPath}${suffix}`)

    expect(() => assertRunFolder(workspace)).toThrow(/sidecar must be a regular file/)
  })

  it.each(['', '-wal', '-journal'])('rejects an untrusted hard-linked SQLite%s file before opening the database', (suffix) => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    const ledgerPath = runLedgerPath(workspace)
    if (suffix) fs.writeFileSync(ledgerPath, 'sqlite placeholder')
    const outside = path.join(root, `outside${suffix || '-main'}`)
    fs.writeFileSync(outside, 'must not be opened')
    fs.linkSync(outside, `${ledgerPath}${suffix}`)

    expect(() => assertRunFolder(workspace)).toThrow(/regular file/)
    expect(fs.readFileSync(outside, 'utf8')).toBe('must not be opened')
  })

  it('caps the aggregate bytes of the database and all SQLite sidecars', () => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    const ledgerPath = runLedgerPath(workspace)
    fs.writeFileSync(ledgerPath, 'sqlite placeholder')
    fs.writeFileSync(`${ledgerPath}-wal`, '')
    fs.truncateSync(`${ledgerPath}-wal`, MAX_IMPORTED_LEDGER_BYTES)

    expect(() => assertRunFolder(workspace)).toThrow(/sidecars exceed the import safety limit/)
  })

  it('opens a verified private snapshot rather than a subsequently replaced workspace database', () => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    const sourcePath = runLedgerPath(workspace)
    const source = new DatabaseSync(sourcePath)
    source.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('original')")
    source.close()

    const snapshot = snapshotRunLedger(workspace)
    fs.unlinkSync(sourcePath)
    const replacement = new DatabaseSync(sourcePath)
    replacement.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('replacement')")
    replacement.close()

    try {
      const opened = new DatabaseSync(snapshot.ledgerPath, { readOnly: true })
      expect(opened.prepare('SELECT value FROM marker').get()).toEqual({ value: 'original' })
      opened.close()
    } finally {
      const snapshotDir = path.dirname(snapshot.ledgerPath)
      snapshot.cleanup()
      expect(fs.existsSync(snapshotDir)).toBe(false)
    }
  })

  it('refuses to publish a stale import snapshot after the selected ledger changes', () => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace)
    const ledger = new Ledger(path.join(root, 'registry.db'))
    const loop = ledger.createLoop({ prompt: 'original', workspaceDir: workspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    ledger.prepareRunFolder(loop.id)
    const snapshot = snapshotRunLedger(workspace)
    const portablePath = runLedgerPath(workspace)
    const changed = new DatabaseSync(portablePath)
    changed.prepare('UPDATE loops SET prompt = ? WHERE id = ?').run('operator changed this source', loop.id)
    changed.close()
    const internal = ledger as unknown as {
      publishWorkspaceFolderAtomically(workspaceDir: string, expected: typeof snapshot.sourceIdentities): void
    }

    try {
      expect(() => internal.publishWorkspaceFolderAtomically(workspace, snapshot.sourceIdentities)).toThrow(/changed after its import snapshot/)
      const preserved = new DatabaseSync(portablePath, { readOnly: true })
      expect(preserved.prepare('SELECT prompt FROM loops WHERE id = ?').get(loop.id)).toEqual({ prompt: 'operator changed this source' })
      preserved.close()
    } finally {
      snapshot.cleanup()
      ledger.close()
    }
  })
})

describe('deleting a run folder', () => {
  function runFolder(root: string, name = 'project'): string {
    const workspace = path.join(root, name)
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    fs.writeFileSync(runLedgerPath(workspace), 'db')
    fs.writeFileSync(path.join(workspace, 'index.html'), '<html></html>')
    return workspace
  }

  it('removes a folder that proves it is a run folder', async () => {
    const root = tempDir()
    const workspace = runFolder(root)
    await deleteRunFolder(workspace, path.join(root, 'home'))
    expect(fs.existsSync(workspace)).toBe(false)
  })

  it('refuses a folder with no ledger inside it', () => {
    const root = tempDir()
    const plain = path.join(root, 'not-a-run')
    fs.mkdirSync(plain)
    expect(() => assertDeletableRunFolder(plain, root)).toThrow(/may not be a run folder/)
  })

  it('refuses the home folder and anything above it', () => {
    const root = tempDir()
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, '.gauntlet-gamesmith'), { recursive: true })
    fs.writeFileSync(runLedgerPath(home), 'db')
    expect(() => assertDeletableRunFolder(home, home)).toThrow(/your home folder/)
    fs.mkdirSync(path.join(root, '.gauntlet-gamesmith'), { recursive: true })
    fs.writeFileSync(runLedgerPath(root), 'db')
    expect(() => assertDeletableRunFolder(root, home)).toThrow(/contains your home folder/)
  })

  it('refuses a filesystem root', () => {
    expect(() => assertDeletableRunFolder(path.parse(process.cwd()).root, os.homedir())).toThrow(/filesystem root/)
  })
})

describe('run folders that predate the rename', () => {
  /** A run folder as it looked when the app was still called Gauntlet Loop. */
  function legacyFolder(root: string): string {
    const workspace = path.join(root, 'old-project')
    fs.mkdirSync(path.join(workspace, LEGACY_RUN_METADATA_DIR), { recursive: true })
    fs.writeFileSync(path.join(workspace, LEGACY_RUN_METADATA_DIR, 'ledger.db'), 'db')
    return workspace
  }

  it('moves the metadata folder onto the current name', () => {
    const root = tempDir()
    const workspace = legacyFolder(root)

    migrateRunMetadataDir(workspace)

    expect(fs.existsSync(path.join(workspace, RUN_METADATA_DIR, 'ledger.db'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, LEGACY_RUN_METADATA_DIR))).toBe(false)
  })

  it('leaves an already-migrated folder alone rather than merging the two', () => {
    const root = tempDir()
    const workspace = legacyFolder(root)
    fs.mkdirSync(path.join(workspace, RUN_METADATA_DIR), { recursive: true })
    fs.writeFileSync(path.join(workspace, RUN_METADATA_DIR, 'ledger.db'), 'current')

    migrateRunMetadataDir(workspace)

    expect(fs.readFileSync(path.join(workspace, RUN_METADATA_DIR, 'ledger.db'), 'utf8')).toBe('current')
    expect(fs.existsSync(path.join(workspace, LEGACY_RUN_METADATA_DIR))).toBe(true)
  })

  it('still recognises a folder nothing has migrated, so it stays deletable', () => {
    // This is the case that stranded four runs before the rename: a folder the
    // app plainly owns, refused because the proof was under the older name.
    const root = tempDir()
    const workspace = legacyFolder(root)

    expect(runLedgerPath(workspace)).toBe(path.join(workspace, LEGACY_RUN_METADATA_DIR, 'ledger.db'))
    expect(() => assertDeletableRunFolder(workspace, path.join(root, 'home'))).not.toThrow()
  })

  it('points a brand-new folder at the current name', () => {
    const root = tempDir()
    expect(runLedgerPath(path.join(root, 'fresh'))).toBe(path.join(root, 'fresh', RUN_METADATA_DIR, 'ledger.db'))
  })
})
