import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { Ledger } from './ledger'
import {
  assertDeletableRunFolder,
  assertExportDestination,
  copyRunFolder,
  deleteRunFolder,
  LEGACY_RUN_METADATA_DIR,
  migrateRunMetadataDir,
  nextAvailableExportPath,
  RUN_METADATA_DIR,
  runLedgerPath,
  safeExportFolderName,
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
    expect(mirroredLoop).toMatchObject({ id: loop.id, workspace_dir: workspace, prompt: 'Build the game' })
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
    expect(imported[0].loop.workspaceDir).toBe(exportedWorkspace)
    expect(imported[0].runs[0]).toMatchObject({ id: sourceRun.id, loopId: sourceLoop.id, finishedAt: eventTs })
    expect(target.eventsForLoop(sourceLoop.id)).toEqual([
      // round/role/channel come from the read-time backfill for legacy rows.
      { loopId: sourceLoop.id, runId: sourceRun.id, ts: eventTs, kind: 'verdict', channel: 'output', round: 1, role: 'critique', text: 'Score 0.72' },
    ])
    target.appendEvent({ loopId: sourceLoop.id, runId: sourceRun.id, ts: eventTs, kind: 'done', text: 'Continued on teammate machine' })

    const importedFolderDb = new DatabaseSync(runLedgerPath(exportedWorkspace), { readOnly: true })
    expect(importedFolderDb.prepare('SELECT workspace_dir FROM loops WHERE id = ?').get(sourceLoop.id)).toEqual({ workspace_dir: exportedWorkspace })
    expect(importedFolderDb.prepare('SELECT seq, text FROM events ORDER BY seq').all()).toEqual([
      { seq: 1, text: 'Score 0.72' },
      { seq: 2, text: 'Continued on teammate machine' },
    ])
    importedFolderDb.close()
    target.close()
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
