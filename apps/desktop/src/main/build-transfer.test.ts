import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { Ledger } from './ledger'
import {
  assertDeletableBuildFolder,
  assertExportDestination,
  assertBuildFolder,
  canonicalizePath,
  copyBuildFolder,
  deleteBuildFolder,
  exportActivityError,
  LEGACY_BUILD_METADATA_DIR,
  LEGACY_METADATA_ARCHIVE_DIR,
  MAX_IMPORTED_LEDGER_BYTES,
  migrateBuildMetadataDir,
  nextAvailableExportPath,
  RAW_EXPORT_WARNING,
  BUILD_METADATA_DIR,
  buildLedgerPath,
  safeExportFolderName,
  snapshotBuildLedger,
} from './build-transfer'

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

describe('build folder transfer', () => {
  it('warns that complete raw stream evidence is intentionally unsanitized', () => {
    expect(RAW_EXPORT_WARNING).toMatch(/unsanitized raw CLI streams/)
    expect(RAW_EXPORT_WARNING).toMatch(/review them before sharing/)
  })
  it('requires both the agent build and Play process to stop before an exact export', () => {
    expect(exportActivityError(true, false)).toMatch(/Stop the build/)
    expect(exportActivityError(false, true)).toMatch(/Stop the running game/)
    expect(exportActivityError(false, false)).toBeNull()
  })
  it('keeps an exact SQLite mirror inside the project folder', () => {
    const root = tempDir()
    const workspace = path.join(root, 'project')
    fs.mkdirSync(workspace)
    const ledger = new Ledger(path.join(root, 'app-ledger.db'))
    const build = ledger.createBuild({ prompt: 'Build the game', workspaceDir: workspace, maxRounds: 4, budgetUsd: 20, models: MODELS })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'Implement it' })
    const finishedAt = new Date().toISOString()
    ledger.patchAttempt(attempt.id, { status: 'succeeded', inputTokens: 12, outputTokens: 8, finishedAt })
    ledger.appendEvent({ buildId: build.id, attemptId: attempt.id, ts: finishedAt, kind: 'done', text: 'Finished exactly once' })
    ledger.prepareBuildFolder(build.id)

    const folderDb = new DatabaseSync(buildLedgerPath(workspace), { readOnly: true })
    const mirroredBuild = folderDb.prepare('SELECT * FROM builds WHERE id = ?').get(build.id) as Record<string, unknown>
    const mirroredAttempt = folderDb.prepare('SELECT * FROM phase_attempts WHERE id = ?').get(attempt.id) as Record<string, unknown>
    const mirroredEvent = folderDb.prepare('SELECT * FROM events WHERE build_id = ?').get(build.id) as Record<string, unknown>
    expect(mirroredBuild).toMatchObject({ id: build.id, workspace_dir: fs.realpathSync(workspace), prompt: 'Build the game' })
    expect(mirroredAttempt).toMatchObject({ id: attempt.id, build_id: build.id, status: 'succeeded', finished_at: finishedAt })
    expect(mirroredEvent).toMatchObject({ build_id: build.id, attempt_id: attempt.id, kind: 'done', text: 'Finished exactly once' })
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
    const sourceBuild = source.createBuild({ prompt: 'Build the game', workspaceDir: sourceWorkspace, maxRounds: 4, budgetUsd: null, models: MODELS })
    const sourceAttempt = source.createAttempt({ buildId: sourceBuild.id, round: 1, role: 'critique', harness: 'codex', prompt: 'Judge it' })
    const eventTs = new Date().toISOString()
    source.patchAttempt(sourceAttempt.id, {
      status: 'succeeded',
      verdict: { score: 0.72, pass: false, summary: 'Keep going', findings: [{ severity: 'major', text: 'More polish' }] },
      finishedAt: eventTs,
    })
    source.appendEvent({ buildId: sourceBuild.id, attemptId: sourceAttempt.id, ts: eventTs, kind: 'verdict', text: 'Score 0.72' })
    source.prepareBuildFolder(sourceBuild.id)
    source.close()

    const exportedWorkspace = path.join(root, 'shared', 'source-project-gauntlet-run')
    await copyBuildFolder(sourceWorkspace, exportedWorkspace)
    expect(fs.readFileSync(path.join(exportedWorkspace, 'game.ts'), 'utf8')).toBe('export const game = true\n')
    expect(fs.readFileSync(path.join(exportedWorkspace, 'reference', 'images', 'reference.txt'), 'utf8')).toBe('downloaded reference')
    expect(fs.readFileSync(path.join(exportedWorkspace, 'critique', 'round-1', 'shots', 'frame.txt'), 'utf8')).toBe('captured frame')
    expect(fs.existsSync(buildLedgerPath(exportedWorkspace))).toBe(true)

    const target = new Ledger(path.join(root, 'target-app.db'))
    const imported = target.importBuildFolder(exportedWorkspace)
    expect(imported).toHaveLength(1)
    expect(imported[0].build.id).toBe(sourceBuild.id)
    expect(imported[0].build.createdAt).toBe(sourceBuild.createdAt)
    expect(imported[0].build.workspaceDir).toBe(fs.realpathSync(exportedWorkspace))
    expect(imported[0].build.status).toBe('stopped')
    expect(imported[0].build.playTrusted).toBe(false)
    expect(imported[0].attempts[0]).toMatchObject({ id: sourceAttempt.id, buildId: sourceBuild.id, finishedAt: eventTs })
    expect(target.eventsForBuild(sourceBuild.id)).toEqual([
      // round/role/channel come from the read-time backfill for legacy rows.
      { buildId: sourceBuild.id, attemptId: sourceAttempt.id, ts: eventTs, kind: 'verdict', channel: 'output', round: 1, role: 'critique', text: 'Score 0.72' },
    ])
    target.appendEvent({ buildId: sourceBuild.id, attemptId: sourceAttempt.id, ts: eventTs, kind: 'done', text: 'Continued on teammate machine' })

    const importedFolderDb = new DatabaseSync(buildLedgerPath(exportedWorkspace), { readOnly: true })
    expect(importedFolderDb.prepare('SELECT workspace_dir FROM builds WHERE id = ?').get(sourceBuild.id)).toEqual({ workspace_dir: fs.realpathSync(exportedWorkspace) })
    expect(importedFolderDb.prepare('SELECT seq, text FROM events ORDER BY seq').all()).toEqual([
      { seq: 1, text: 'Score 0.72' },
      { seq: 2, text: 'Continued on teammate machine' },
    ])
    importedFolderDb.close()
    const [reimported] = target.importBuildFolder(exportedWorkspace)
    expect(reimported.build.id).toBe(sourceBuild.id)
    expect(target.eventsForBuild(sourceBuild.id).map((event) => event.text)).toEqual([
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
    const sourceBuild = source.createBuild({ prompt: 'portable history', workspaceDir: workspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.createAttempt({ buildId: sourceBuild.id, round: 1, role: 'implement', harness: 'codex', prompt: 'preserve me' })
    source.prepareBuildFolder(sourceBuild.id)
    source.close()
    const portablePath = buildLedgerPath(workspace)
    const before = fs.readFileSync(portablePath)

    const unrelated = new Ledger(path.join(root, 'unrelated.db'))
    expect(() => unrelated.createBuild({ prompt: 'new history', workspaceDir: workspace, maxRounds: 1, budgetUsd: null, models: MODELS }))
      .toThrow(/Import its history/)
    expect(fs.readFileSync(portablePath)).toEqual(before)
    unrelated.close()
  })

  it('downgrades imported queued and running attempts instead of recovering untrusted process metadata', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const build = source.createBuild({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 2, budgetUsd: null, models: MODELS })
    const queued = source.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'queued' })
    const running = source.createAttempt({ buildId: build.id, round: 1, role: 'critique', harness: 'codex', prompt: 'running' })
    source.patchAttempt(running.id, { status: 'running' })
    source.setAttemptProcessOwnership(running.id, {
      pid: 4242,
      processIdentity: 'Thu Sep  3 01:00:00 2026',
      groupIdentities: ['4242:Thu Sep  3 01:00:00 2026'],
      startedAtMs: 1_788_399_600_000,
      outDev: 1,
      outIno: 2,
      errDev: 1,
      errIno: 3,
    })
    source.prepareBuildFolder(build.id)
    source.close()

    const target = new Ledger(path.join(root, 'target.db'))
    const [snapshot] = target.importBuildFolder(sourceWorkspace)

    expect(snapshot.build).toMatchObject({ status: 'stopped', playTrusted: false })
    expect(snapshot.attempts.find((attempt) => attempt.id === queued.id)).toMatchObject({ status: 'interrupted' })
    expect(snapshot.attempts.find((attempt) => attempt.id === running.id)).toMatchObject({ status: 'interrupted' })
    expect(target.attemptProcessOwnership(running.id)).toBeNull()
    const folder = new DatabaseSync(buildLedgerPath(sourceWorkspace), { readOnly: true })
    expect(folder.prepare('SELECT play_trusted, status FROM builds WHERE id = ?').get(build.id)).toEqual({ play_trusted: 0, status: 'stopped' })
    expect(folder.prepare('SELECT status FROM phase_attempts ORDER BY created_at, rowid').all()).toEqual([{ status: 'interrupted' }, { status: 'interrupted' }])
    folder.close()
    target.close()
  })

  it('compensates the registry without overwriting entries that raced mirror publication', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source-crash-order')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source-crash-order.db'))
    const build = source.createBuild({ prompt: 'portable source', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.prepareBuildFolder(build.id)
    source.close()
    const portablePath = buildLedgerPath(sourceWorkspace)
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
    expect(() => target.importBuildFolder(sourceWorkspace)).toThrow(/synthetic crash.*could not be restored/i)
    expect(target.getBuild(build.id)).toBeNull()
    expect(fs.readFileSync(portablePath, 'utf8')).toBe('partial replacement')
    expect(fs.readFileSync(journalPath, 'utf8')).toBe('partial sidecar')
    target.close()

    const reopened = new Ledger(targetPath)
    expect(reopened.getBuild(build.id)).toBeNull()
    reopened.close()
  })

  it('restores the selected portable source when normalized publication fails after publish', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source-post-publish')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source-post-publish.db'))
    const build = source.createBuild({ prompt: 'exact source', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.prepareBuildFolder(build.id)
    source.close()
    const metadataDir = fs.realpathSync(path.dirname(buildLedgerPath(sourceWorkspace)))
    const originalOpen = fs.openSync.bind(fs)
    const open = vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(target) === metadataDir) throw new Error('synthetic post-publish directory fsync failure')
      return originalOpen(target, flags, mode)
    }) as typeof fs.openSync)
    const target = new Ledger(path.join(root, 'target-post-publish.db'))

    try {
      expect(() => target.importBuildFolder(sourceWorkspace)).toThrow(/post-publish directory fsync failure/)
      expect(target.getBuild(build.id)).toBeNull()
      const restored = new DatabaseSync(buildLedgerPath(sourceWorkspace), { readOnly: true })
      expect(restored.prepare('SELECT prompt FROM builds WHERE id = ?').get(build.id)).toEqual({ prompt: 'exact source' })
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
    const build = ledger.createBuild({ prompt: 'p', workspaceDir: localWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'build' })
    ledger.patchAttempt(attempt.id, { status: 'running' })
    ledger.prepareBuildFolder(build.id)

    expect(() => ledger.importBuildFolder(localWorkspace)).toThrow(/while one of its local builds is active/)
    expect(ledger.getBuild(build.id)).toMatchObject({ status: 'running', playTrusted: true })
    expect(ledger.getAttempt(attempt.id)?.status).toBe('running')
    const unchanged = new DatabaseSync(buildLedgerPath(localWorkspace), { readOnly: true })
    expect(unchanged.prepare('SELECT status, play_trusted FROM builds WHERE id = ?').get(build.id)).toEqual({ status: 'running', play_trusted: 1 })
    unchanged.close()

    ledger.transaction(() => {
      ledger.patchAttempt(attempt.id, { status: 'interrupted' })
      ledger.patchBuild(build.id, { status: 'stopped' })
    })
    const tampered = new DatabaseSync(buildLedgerPath(localWorkspace))
    tampered.prepare('UPDATE phase_attempts SET prompt = ?, session_id = ? WHERE id = ?').run('execute mirror payload', 'attacker_session', attempt.id)
    tampered.close()

    expect(() => ledger.importBuildFolder(localWorkspace)).toThrow(/already registered as trusted local history/)
    expect(ledger.getBuild(build.id)).toMatchObject({ status: 'stopped', playTrusted: true })
    expect(ledger.getAttempt(attempt.id)).toMatchObject({ prompt: 'build', sessionId: null })
    const stillTampered = new DatabaseSync(buildLedgerPath(localWorkspace), { readOnly: true })
    expect(stillTampered.prepare('SELECT prompt, session_id FROM phase_attempts WHERE id = ?').get(attempt.id)).toEqual({
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
    const build = source.createBuild({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    const attempt = source.createAttempt({ buildId: build.id, round: 1, role: 'critique', harness: 'codex', prompt: 'judge' })
    source.prepareBuildFolder(build.id)
    source.close()
    const folder = new DatabaseSync(buildLedgerPath(sourceWorkspace))
    folder.prepare('UPDATE phase_attempts SET verdict_json = ? WHERE id = ?').run(
      JSON.stringify({ score: '0.9', pass: true, summary: 'invalid', findings: [] }),
      attempt.id,
    )
    folder.close()

    const target = new Ledger(path.join(root, 'target.db'))
    expect(() => target.importBuildFolder(sourceWorkspace)).toThrow(/verdict contract/)
    expect(target.builds()).toEqual([])
    const unchanged = new DatabaseSync(buildLedgerPath(sourceWorkspace), { readOnly: true })
    expect(unchanged.prepare('SELECT workspace_dir, play_trusted, status FROM builds WHERE id = ?').get(build.id)).toEqual({
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
    const build = source.createBuild({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    const attempt = source.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'build' })
    source.prepareBuildFolder(build.id)
    source.close()
    const folder = new DatabaseSync(buildLedgerPath(sourceWorkspace))
    folder.prepare('UPDATE phase_attempts SET session_id = ? WHERE id = ?').run('../../private/session', attempt.id)
    folder.close()

    const target = new Ledger(path.join(root, 'target-session.db'))
    expect(() => target.importBuildFolder(sourceWorkspace)).toThrow(/invalid session id/)
    expect(target.builds()).toEqual([])
    target.close()
  })

  it('rewrites imported structured strings redacted while preserving accounting values', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source-redaction')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source-redaction.db'))
    const build = source.createBuild({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    const attempt = source.createAttempt({ buildId: build.id, round: 1, role: 'critique', harness: 'codex', prompt: 'judge' })
    source.appendEvent({ buildId: build.id, attemptId: attempt.id, ts: '2026-01-01T00:00:00.000Z', kind: 'system', text: 'safe' })
    source.prepareBuildFolder(build.id)
    source.close()
    const secret = `ghp_${'a'.repeat(36)}`
    const folder = new DatabaseSync(buildLedgerPath(sourceWorkspace))
    folder.prepare('UPDATE events SET text = ?').run(`event ${secret}`)
    folder.prepare('UPDATE builds SET models_json = ? WHERE id = ?').run(JSON.stringify({
      ...MODELS,
      orchestratorModel: `gpt-${secret}`,
      subagentModel: `claude-${secret}`,
    }), build.id)
    folder.prepare('UPDATE phase_attempts SET verdict_json = ?, metrics_json = ?, model = ?, cli_version = ?, cost_source = ?, account_label = ?, machine_label = ? WHERE id = ?').run(
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
      attempt.id,
    )
    folder.close()

    const target = new Ledger(path.join(root, 'target-redaction.db'))
    const [snapshot] = target.importBuildFolder(sourceWorkspace)
    expect(target.eventsForBuild(build.id)[0].text).toBe('event [REDACTED]')
    expect(snapshot.attempts[0].verdict).toEqual({
      score: 0.5,
      pass: false,
      summary: 'summary [REDACTED]',
      findings: [{ severity: 'major', text: 'finding [REDACTED]' }],
    })
    expect(snapshot.attempts[0].metrics?.agents[0]).toEqual(expect.objectContaining({
      label: 'worker [REDACTED]', prompt: 'prompt [REDACTED]', note: 'note [REDACTED]', lastTool: 'tool [REDACTED]',
      model: '[REDACTED]', messages: 2, tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 }, costUsd: 0.5,
    }))
    expect(snapshot.attempts[0]).toMatchObject({
      model: '[REDACTED]', cliVersion: 'codex [REDACTED]', costSource: 'rate [REDACTED]',
      accountLabel: 'codex:[REDACTED]', machineLabel: 'host-[REDACTED]',
    })
    expect(snapshot.attempts[0].metrics?.perModel['[REDACTED]']).toEqual({
      costUsd: 0.5, tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 },
    })
    expect(snapshot.build.models.orchestratorModel).toBe('claude-opus-5')
    expect(snapshot.build.models.subagentModel).toBe('claude-opus-5')
    expect(JSON.stringify(snapshot.build.models)).not.toContain(secret)
    const rewritten = new DatabaseSync(buildLedgerPath(sourceWorkspace), { readOnly: true })
    expect(rewritten.prepare('SELECT text FROM events').get()).toEqual({ text: 'event [REDACTED]' })
    const persistedAttempt = rewritten.prepare('SELECT verdict_json, metrics_json, model, cli_version, cost_source, account_label, machine_label FROM phase_attempts WHERE id = ?').get(attempt.id) as {
      verdict_json: string
      metrics_json: string
      model: string
      cli_version: string
      cost_source: string
      account_label: string
      machine_label: string
    }
    expect(JSON.stringify(persistedAttempt)).not.toContain(secret)
    rewritten.close()
    target.close()
  })

  it.each([
    ['builds', 'created_at'],
    ['phase_attempts', 'created_at'],
    ['events', 'ts'],
  ] as const)('rejects a malformed imported %s.%s timestamp', (table, column) => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const build = source.createBuild({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    const attempt = source.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'build' })
    source.appendEvent({ buildId: build.id, attemptId: attempt.id, ts: new Date().toISOString(), kind: 'system', text: 'event' })
    source.prepareBuildFolder(build.id)
    source.close()
    const folder = new DatabaseSync(buildLedgerPath(sourceWorkspace))
    folder.exec(`UPDATE ${table} SET ${column} = 'not-a-date'`)
    folder.close()

    const target = new Ledger(path.join(root, 'target.db'))
    expect(() => target.importBuildFolder(sourceWorkspace)).toThrow(/canonical ISO timestamp/)
    expect(target.builds()).toEqual([])
    target.close()
  })

  it('rejects a transferred expression index even when it reuses an expected index name', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const build = source.createBuild({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'build' })
    source.prepareBuildFolder(build.id)
    source.close()
    const folder = new DatabaseSync(buildLedgerPath(sourceWorkspace))
    folder.exec('DROP INDEX idx_attempts_build; CREATE INDEX idx_attempts_build ON phase_attempts(substr(prompt, 1, 1));')
    folder.close()

    const target = new Ledger(path.join(root, 'target.db'))
    expect(() => target.importBuildFolder(sourceWorkspace)).toThrow(/unsupported index definition/)
    expect(target.builds()).toEqual([])
    target.close()
  })

  it('rejects an allowed-column schema whose identity primary key was removed', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const build = source.createBuild({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'build' })
    source.prepareBuildFolder(build.id)
    source.close()
    const folder = new DatabaseSync(buildLedgerPath(sourceWorkspace))
    folder.exec(`
      DROP INDEX idx_attempts_build;
      CREATE TABLE attempts_without_pk AS SELECT * FROM phase_attempts;
      DROP TABLE phase_attempts;
      ALTER TABLE attempts_without_pk RENAME TO phase_attempts;
      INSERT INTO phase_attempts SELECT * FROM phase_attempts;
      CREATE INDEX idx_attempts_build ON phase_attempts(build_id, created_at);
    `)
    folder.close()

    const target = new Ledger(path.join(root, 'target.db'))
    expect(() => target.importBuildFolder(sourceWorkspace)).toThrow(/phase_attempts\.id primary-key constraint is missing/)
    expect(target.builds()).toEqual([])
    target.close()
  })

  it('rejects virtual generated columns before integrity checks or row materialization', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source-generated')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source-generated.db'))
    const build = source.createBuild({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'build' })
    source.prepareBuildFolder(build.id)
    source.close()
    const folder = new DatabaseSync(buildLedgerPath(sourceWorkspace))
    folder.exec('ALTER TABLE phase_attempts ADD COLUMN expansion BLOB GENERATED ALWAYS AS (zeroblob(268435456)) VIRTUAL')
    folder.close()

    const target = new Ledger(path.join(root, 'target-generated.db'))
    expect(() => target.importBuildFolder(sourceWorkspace)).toThrow(/generated or hidden columns/)
    expect(target.builds()).toEqual([])
    target.close()
  })

  it('rejects forged non-UUID record ids before mutating or registering an import', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const build = source.createBuild({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.prepareBuildFolder(build.id)
    source.close()
    const folder = new DatabaseSync(buildLedgerPath(sourceWorkspace))
    folder.prepare('UPDATE builds SET id = ? WHERE id = ?').run('forged:build', build.id)
    folder.close()

    const target = new Ledger(path.join(root, 'target.db'))
    expect(() => target.importBuildFolder(sourceWorkspace)).toThrow(/Build id has an invalid format/)
    expect(target.builds()).toEqual([])
    const unchanged = new DatabaseSync(buildLedgerPath(sourceWorkspace), { readOnly: true })
    expect(unchanged.prepare('SELECT id, play_trusted, status FROM builds').get()).toEqual({
      id: 'forged:build',
      play_trusted: 1,
      status: 'running',
    })
    unchanged.close()
    target.close()
  })

  it('rejects a build UUID collision without replacing history from another workspace', () => {
    const root = tempDir()
    const localWorkspace = path.join(root, 'local')
    const transferWorkspace = path.join(root, 'transfer')
    fs.mkdirSync(localWorkspace)
    fs.mkdirSync(transferWorkspace)

    const target = new Ledger(path.join(root, 'target.db'))
    const localBuild = target.createBuild({ prompt: 'local history', workspaceDir: localWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    const localAttempt = target.createAttempt({ buildId: localBuild.id, round: 1, role: 'implement', harness: 'claude', prompt: 'keep me' })
    target.appendEvent({ buildId: localBuild.id, attemptId: localAttempt.id, ts: '2026-01-01T00:00:00.000Z', kind: 'system', text: 'preserve me' })

    const source = new Ledger(path.join(root, 'source.db'))
    const transferBuild = source.createBuild({ prompt: 'transferred history', workspaceDir: transferWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.prepareBuildFolder(transferBuild.id)
    source.close()
    const folder = new DatabaseSync(buildLedgerPath(transferWorkspace))
    folder.prepare('UPDATE builds SET id = ? WHERE id = ?').run(localBuild.id, transferBuild.id)
    folder.close()

    expect(() => target.importBuildFolder(transferWorkspace)).toThrow(/collides with history owned by another workspace/)
    expect(target.getBuild(localBuild.id)).toMatchObject({ prompt: 'local history', workspaceDir: fs.realpathSync(localWorkspace) })
    expect(target.getAttempt(localAttempt.id)).toMatchObject({ prompt: 'keep me' })
    expect(target.eventsForBuild(localBuild.id).map((event) => event.text)).toEqual(['preserve me'])
    target.close()
  })

  it('repairs a stale folder mirror before returning an export snapshot', () => {
    const root = tempDir()
    const sourceWorkspace = path.join(root, 'source')
    fs.mkdirSync(sourceWorkspace)
    const source = new Ledger(path.join(root, 'source.db'))
    const build = source.createBuild({ prompt: 'p', workspaceDir: sourceWorkspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    source.appendEvent({ buildId: build.id, attemptId: null, ts: '2026-01-01T00:00:00.000Z', kind: 'system', text: 'must survive export' })
    const stale = new DatabaseSync(buildLedgerPath(sourceWorkspace))
    stale.exec('DELETE FROM events')
    stale.close()

    source.prepareBuildFolder(build.id)

    const repaired = new DatabaseSync(buildLedgerPath(sourceWorkspace), { readOnly: true })
    expect(repaired.prepare('SELECT text FROM events').all()).toEqual([{ text: 'must survive export' }])
    repaired.close()
    source.close()
  })

  it('migrates and imports a project-folder ledger from the previous schema', () => {
    const root = tempDir()
    const workspace = path.join(root, 'legacy-project')
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    const legacy = new DatabaseSync(buildLedgerPath(workspace))
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
    const [snapshot] = target.importBuildFolder(workspace)
    expect(snapshot).toMatchObject({
      build: { id: '11111111-1111-4111-8111-111111111111', playTrusted: false },
      attempts: [{ id: '22222222-2222-4222-8222-222222222222', revision: null }],
    })
    target.close()

    const migrated = new DatabaseSync(buildLedgerPath(workspace), { readOnly: true })
    const names = (table: string): string[] =>
      (migrated.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((column) => column.name)
    expect(names('builds')).toEqual(expect.arrayContaining(['title', 'play_trusted']))
    expect(names('phase_attempts')).toEqual(
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

    await expect(copyBuildFolder(source, destination)).rejects.toThrow()
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
      await expect(copyBuildFolder(source, destination)).rejects.toThrow(/simulated copy failure/)
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
      await expect(copyBuildFolder(source, destination)).rejects.toThrow(/after replacement/)
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
      await expect(copyBuildFolder(source, destination)).rejects.toThrow(/destination changed identity/)
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

    await expect(copyBuildFolder(source, destination, { dev: stat.dev, ino: stat.ino + 1 })).rejects.toThrow(/canonical workspace identity/)
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('rejects a folder ledger symlink', () => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    const outside = path.join(root, 'outside.db')
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    fs.writeFileSync(outside, 'not really sqlite')
    fs.symlinkSync(outside, buildLedgerPath(workspace))

    expect(() => assertBuildFolder(workspace)).toThrow(/regular file, not a symlink/)
  })

  it.each(['-wal', '-journal'])('rejects an untrusted SQLite %s sidecar symlink before opening the database', (suffix) => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    const ledgerPath = buildLedgerPath(workspace)
    fs.writeFileSync(ledgerPath, 'sqlite placeholder')
    const outside = path.join(root, `outside${suffix}`)
    fs.writeFileSync(outside, 'must not be opened')
    fs.symlinkSync(outside, `${ledgerPath}${suffix}`)

    expect(() => assertBuildFolder(workspace)).toThrow(/sidecar must be a regular file/)
  })

  it.each(['', '-wal', '-journal'])('rejects an untrusted hard-linked SQLite%s file before opening the database', (suffix) => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    const ledgerPath = buildLedgerPath(workspace)
    if (suffix) fs.writeFileSync(ledgerPath, 'sqlite placeholder')
    const outside = path.join(root, `outside${suffix || '-main'}`)
    fs.writeFileSync(outside, 'must not be opened')
    fs.linkSync(outside, `${ledgerPath}${suffix}`)

    expect(() => assertBuildFolder(workspace)).toThrow(/regular file/)
    expect(fs.readFileSync(outside, 'utf8')).toBe('must not be opened')
  })

  it('caps the aggregate bytes of the database and all SQLite sidecars', () => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    const ledgerPath = buildLedgerPath(workspace)
    fs.writeFileSync(ledgerPath, 'sqlite placeholder')
    fs.writeFileSync(`${ledgerPath}-wal`, '')
    fs.truncateSync(`${ledgerPath}-wal`, MAX_IMPORTED_LEDGER_BYTES)

    expect(() => assertBuildFolder(workspace)).toThrow(/sidecars exceed the import safety limit/)
  })

  it('opens a verified private snapshot rather than a subsequently replaced workspace database', () => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    const sourcePath = buildLedgerPath(workspace)
    const source = new DatabaseSync(sourcePath)
    source.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('original')")
    source.close()

    const snapshot = snapshotBuildLedger(workspace)
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
    const build = ledger.createBuild({ prompt: 'original', workspaceDir: workspace, maxRounds: 1, budgetUsd: null, models: MODELS })
    ledger.prepareBuildFolder(build.id)
    const snapshot = snapshotBuildLedger(workspace)
    const portablePath = buildLedgerPath(workspace)
    const changed = new DatabaseSync(portablePath)
    changed.prepare('UPDATE builds SET prompt = ? WHERE id = ?').run('operator changed this source', build.id)
    changed.close()
    const internal = ledger as unknown as {
      publishWorkspaceFolderAtomically(workspaceDir: string, expected: typeof snapshot.sourceIdentities): void
    }

    try {
      expect(() => internal.publishWorkspaceFolderAtomically(workspace, snapshot.sourceIdentities)).toThrow(/changed after its import snapshot/)
      const preserved = new DatabaseSync(portablePath, { readOnly: true })
      expect(preserved.prepare('SELECT prompt FROM builds WHERE id = ?').get(build.id)).toEqual({ prompt: 'operator changed this source' })
      preserved.close()
    } finally {
      snapshot.cleanup()
      ledger.close()
    }
  })
})

describe('deleting a build folder', () => {
  function buildFolder(root: string, name = 'project'): string {
    const workspace = path.join(root, name)
    fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith'), { recursive: true })
    fs.writeFileSync(buildLedgerPath(workspace), 'db')
    fs.writeFileSync(path.join(workspace, 'index.html'), '<html></html>')
    return workspace
  }

  it('removes a folder that proves it is a build folder', async () => {
    const root = tempDir()
    const workspace = buildFolder(root)
    await deleteBuildFolder(workspace, path.join(root, 'home'))
    expect(fs.existsSync(workspace)).toBe(false)
  })

  it('refuses a folder with no ledger inside it', () => {
    const root = tempDir()
    const plain = path.join(root, 'not-a-build')
    fs.mkdirSync(plain)
    expect(() => assertDeletableBuildFolder(plain, root)).toThrow(/may not be a build folder/)
  })

  it('refuses the home folder and anything above it', () => {
    const root = tempDir()
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, '.gauntlet-gamesmith'), { recursive: true })
    fs.writeFileSync(buildLedgerPath(home), 'db')
    expect(() => assertDeletableBuildFolder(home, home)).toThrow(/your home folder/)
    fs.mkdirSync(path.join(root, '.gauntlet-gamesmith'), { recursive: true })
    fs.writeFileSync(buildLedgerPath(root), 'db')
    expect(() => assertDeletableBuildFolder(root, home)).toThrow(/contains your home folder/)
  })

  it('refuses a filesystem root', () => {
    expect(() => assertDeletableBuildFolder(path.parse(process.cwd()).root, os.homedir())).toThrow(/filesystem root/)
  })
})

describe('build folders that predate the rename', () => {
  /** A build folder as it looked when the app was still called Gauntlet Loop. */
  function legacyFolder(root: string): string {
    const workspace = path.join(root, 'old-project')
    fs.mkdirSync(path.join(workspace, LEGACY_BUILD_METADATA_DIR), { recursive: true })
    fs.writeFileSync(path.join(workspace, LEGACY_BUILD_METADATA_DIR, 'ledger.db'), 'db')
    return workspace
  }

  it('moves the metadata folder onto the current name', () => {
    const root = tempDir()
    const workspace = legacyFolder(root)

    migrateBuildMetadataDir(workspace)

    expect(fs.existsSync(path.join(workspace, BUILD_METADATA_DIR, 'ledger.db'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, LEGACY_BUILD_METADATA_DIR))).toBe(false)
  })

  it('removes the old top-level name while retaining its evidence when the current folder exists', () => {
    const root = tempDir()
    const workspace = legacyFolder(root)
    fs.mkdirSync(path.join(workspace, BUILD_METADATA_DIR), { recursive: true })
    fs.writeFileSync(path.join(workspace, BUILD_METADATA_DIR, 'ledger.db'), 'current')

    migrateBuildMetadataDir(workspace)

    expect(fs.readFileSync(path.join(workspace, BUILD_METADATA_DIR, 'ledger.db'), 'utf8')).toBe('current')
    expect(fs.existsSync(path.join(workspace, LEGACY_BUILD_METADATA_DIR))).toBe(false)
    expect(fs.readFileSync(path.join(workspace, BUILD_METADATA_DIR, LEGACY_METADATA_ARCHIVE_DIR, 'ledger.db'), 'utf8')).toBe('db')
  })

  it('still recognises a folder nothing has migrated, so it stays deletable', () => {
    // This is the case that stranded four builds before the rename: a folder the
    // app plainly owns, refused because the proof was under the older name.
    const root = tempDir()
    const workspace = legacyFolder(root)

    expect(buildLedgerPath(workspace)).toBe(path.join(workspace, LEGACY_BUILD_METADATA_DIR, 'ledger.db'))
    expect(() => assertDeletableBuildFolder(workspace, path.join(root, 'home'))).not.toThrow()
  })

  it('points a brand-new folder at the current name', () => {
    const root = tempDir()
    expect(buildLedgerPath(path.join(root, 'fresh'))).toBe(path.join(root, 'fresh', BUILD_METADATA_DIR, 'ledger.db'))
  })
})
