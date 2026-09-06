import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { playAccessError } from './play'
import { Ledger } from './ledger'
import { trustExistingBuild } from './trust-ipc'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { rawStreamTrustError } from './raw-streams'
import { withExistingBuildTrust } from '../renderer/src/lib/trusted-action'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => undefined) } }))

const roots: string[] = []
const ledgers: Ledger[] = []
function setup(protectedRoots: string[] = []) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-trust-')))
  roots.push(root)
  const dbPath = path.join(root, 'registry.db')
  const ledger = new Ledger(dbPath, { protectedRoots: () => protectedRoots })
  ledgers.push(ledger)
  const workspaceDir = path.join(root, 'game')
  fs.mkdirSync(workspaceDir)
  const build = ledger.createBuild({ prompt: 'An existing game', workspaceDir, maxRounds: 2, budgetUsd: null,
    models: resolveModels({ orchestratorModel: 'gpt-5.6-sol', orchestratorEffort: 'high', subagentModel: null, subagentEffort: 'medium' }, DEFAULT_CRITIC) })
  ledger.patchBuild(build.id, { status: 'stopped', playTrusted: false })
  const portablePath = path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db')
  const invoke = (dialog = vi.fn(async () => ({ response: 1 })), active = () => false) => {
    const notify = vi.fn()
    return { dialog, notify, result: trustExistingBuild(ledger, build.id, dialog, notify, active) }
  }
  return { root, ledger, build: ledger.getBuild(build.id)!, dbPath, portablePath, invoke }
}
function sql(file: string, statement: string) {
  const db = new DatabaseSync(file)
  try { db.exec(statement) } finally { db.close() }
}
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('existing-build trust boundary', () => {
  it('uses a native warning with exact title/path, Cancel default and escape, and durable consent in both ledgers', async () => {
    const { ledger, build, portablePath, dbPath, invoke } = setup()
    const { result, dialog, notify } = invoke()
    expect(await result).toMatchObject({ ok: true, value: { id: build.id, executionTrusted: true, playTrusted: false } })
    expect(dialog).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', buttons: ['Cancel', 'Trust build & folder'], defaultId: 0, cancelId: 0,
      detail: expect.stringContaining(`Build: ${build.title}\nFolder: ${build.workspaceDir}`) }))
    expect(dialog).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('local user permissions') }))
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: build.id }), expect.objectContaining({ kind: 'trust', channel: 'system', text: expect.stringContaining('Operator explicitly trusted') }))
    for (const file of [dbPath, portablePath]) {
      const db = new DatabaseSync(file, { readOnly: true })
      expect(db.prepare('SELECT execution_trusted, play_trusted FROM builds WHERE id = ?').get(build.id)).toMatchObject({ execution_trusted: 1, play_trusted: 0 })
      expect(db.prepare("SELECT text FROM events WHERE kind = 'trust'").get()?.text).toContain(build.workspaceDir)
      db.close()
    }
    expect(rawStreamTrustError(ledger.getBuild(build.id)!.playTrusted)).not.toBeNull()
    expect(playAccessError(build)).not.toBeNull()
    expect(playAccessError(ledger.getBuild(build.id)!)).toBeNull()
    ledger.close(); ledgers.splice(ledgers.indexOf(ledger), 1)
    const reopened = new Ledger(dbPath); ledgers.push(reopened)
    expect(reopened.getBuild(build.id)?.executionTrusted).toBe(true)
  })

  it.each([0, -1, 2])('cancels safely for native response %s', async (response) => {
    const { ledger, build, invoke } = setup()
    const { result, notify } = invoke(vi.fn(async () => ({ response })))
    expect(await result).toEqual({ ok: true, value: null })
    expect(ledger.getBuild(build.id)?.executionTrusted).toBe(false)
    expect(ledger.eventsForBuild(build.id)).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })

  it('validates unknown IPC values before showing a dialog', async () => {
    const { ledger } = setup()
    const dialog = vi.fn()
    for (const value of [null, {}, { buildId: 'x', trusted: true }, '../game', 42]) {
      expect(await trustExistingBuild(ledger, value, dialog, vi.fn(), () => false)).toMatchObject({ ok: false })
    }
    expect(dialog).not.toHaveBeenCalled()
  })

  it.each(['path', 'history', 'active', 'ownership', 'quarantine', 'protected', 'identity'])('rejects %s problems before prompting', async (kind) => {
    const protectedRoots: string[] = []
    const { ledger, build, dbPath, portablePath, invoke } = setup(protectedRoots)
    if (kind === 'path') sql(dbPath, "UPDATE builds SET workspace_dir = workspace_dir || '/moved'")
    if (kind === 'history') sql(portablePath, "UPDATE builds SET prompt = 'replaced prompt'")
    if (kind === 'active') ledger.patchBuild(build.id, { status: 'running' })
    if (kind === 'ownership' || kind === 'quarantine') {
      const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'codex', prompt: 'go' })
      if (kind === 'ownership') sql(dbPath, "UPDATE phase_attempts SET process_ownership_json = '{}'")
      else ledger.patchAttempt(attempt.id, { error: 'Launch identity was not durably recorded before the app exited. unknown writer' })
    }
    if (kind === 'protected') protectedRoots.push(build.workspaceDir)
    if (kind === 'identity') sql(dbPath, 'UPDATE builds SET workspace_ino = workspace_ino + 1')
    const { result, dialog } = invoke()
    expect(await result).toMatchObject({ ok: false })
    expect(dialog).not.toHaveBeenCalled()
    expect(ledger.getBuild(build.id)?.executionTrusted).toBe(false)
  })

  it.each(['title', 'history', 'script', 'path', 'identity', 'active', 'play'])('rejects %s changes while the dialog is open', async (kind) => {
    const { ledger, build, dbPath, portablePath, invoke } = setup()
    let activePlay = false
    const { result } = invoke(vi.fn(async () => {
      if (kind === 'title') sql(dbPath, "UPDATE builds SET title = 'Different title'")
      if (kind === 'history') sql(portablePath, "UPDATE builds SET max_rounds = 3")
      if (kind === 'script') fs.writeFileSync(path.join(build.workspaceDir, 'game.js'), 'changed')
      if (kind === 'path') sql(dbPath, "UPDATE builds SET workspace_dir = workspace_dir || '/changed'")
      if (kind === 'identity') sql(dbPath, 'UPDATE builds SET workspace_ino = workspace_ino + 1')
      if (kind === 'active') ledger.patchBuild(build.id, { status: 'running' })
      if (kind === 'play') activePlay = true
      return { response: 1 }
    }), () => activePlay)
    expect(await result).toMatchObject({ ok: false })
    expect(ledger.getBuild(build.id)?.executionTrusted).toBe(false)
  })

  it('rejects changed attempt/event history and executable portable schema', async () => {
    for (const mutation of [
      "UPDATE phase_attempts SET session_id = 'another-private-session'",
      "UPDATE events SET text = 'changed history'",
      "CREATE TRIGGER unexpected AFTER UPDATE ON builds BEGIN DELETE FROM events; END",
    ]) {
      const { ledger, build, portablePath, invoke } = setup()
      ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'codex', prompt: 'go' })
      ledger.appendEvent({ buildId: build.id, attemptId: null, ts: new Date().toISOString(), kind: 'system', text: 'original' })
      sql(portablePath, mutation)
      const { result, dialog } = invoke()
      expect(await result).toMatchObject({ ok: false })
      expect(dialog).not.toHaveBeenCalled()
    }
  })

  it('rejects a replaced portable ledger even with identical contents while confirmation is open', async () => {
    const { ledger, build, portablePath, invoke } = setup()
    const { result } = invoke(vi.fn(async () => {
      const replacement = `${portablePath}.replacement`
      fs.copyFileSync(portablePath, replacement)
      fs.renameSync(replacement, portablePath)
      return { response: 1 }
    }))
    expect(await result).toMatchObject({ ok: false })
    expect(ledger.getBuild(build.id)?.executionTrusted).toBe(false)
  })

  it('rejects external links without reading their target contents', async () => {
    const { root, build, invoke } = setup()
    const target = path.join(root, 'external')
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(build.workspaceDir, 'linked-directory'))
    const { result, dialog } = invoke()
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('outside') })
    expect(dialog).not.toHaveBeenCalled()
  })

  it('does not prompt for new locally trusted builds', async () => {
    const { ledger, build, invoke } = setup()
    ledger.patchBuild(build.id, { playTrusted: true })
    const { result, dialog } = invoke()
    expect(await result).toMatchObject({ ok: true, value: { playTrusted: true } })
    expect(dialog).not.toHaveBeenCalled()
  })

  it.each(['before-commit', 'after-commit'])('revokes execution trust on %s persistence failure and never continues Play', async (when) => {
    const { ledger, build, portablePath } = setup()
    if (when === 'before-commit') {
      vi.spyOn(ledger, 'appendEvent').mockImplementationOnce(() => { throw new Error('write failed') })
    } else {
      const transaction = ledger.transaction.bind(ledger)
      vi.spyOn(ledger, 'transaction').mockImplementationOnce((work) => {
        transaction(work)
        throw new Error('post-canonical persistence failure')
      })
    }
    const play = vi.fn()
    await expect(withExistingBuildTrust(build,
      (id) => trustExistingBuild(ledger, id, async () => ({ response: 1 }), vi.fn(), () => false),
      () => true, play)).rejects.toThrow(/fail/)
    expect(play).not.toHaveBeenCalled()
    expect(ledger.getBuild(build.id)?.executionTrusted).toBe(false)
    const portable = new DatabaseSync(portablePath, { readOnly: true })
    expect(portable.prepare('SELECT execution_trusted FROM builds').get()?.execution_trusted).toBe(0)
    portable.close()
    expect(ledger.eventsForBuild(build.id).at(-1)?.text).toContain('execution trust was revoked')
  })

  it('trusts only the build named in the dialog when a folder contains multiple histories', async () => {
    const { ledger, build, invoke } = setup()
    const sibling = ledger.createBuild({ prompt: 'Sibling game', workspaceDir: build.workspaceDir, maxRounds: 2, budgetUsd: null, models: build.models })
    ledger.patchBuild(sibling.id, { status: 'stopped', playTrusted: false })
    expect(await invoke().result).toMatchObject({ ok: true })
    expect(ledger.getBuild(build.id)?.executionTrusted).toBe(true)
    expect(ledger.getBuild(sibling.id)?.executionTrusted).toBe(false)
  })

  it('migrates the previous schema with execution trust denied in both ledgers', () => {
    const { ledger, build, dbPath, portablePath } = setup()
    ledger.close(); ledgers.splice(ledgers.indexOf(ledger), 1)
    for (const file of [dbPath, portablePath]) sql(file, 'ALTER TABLE builds DROP COLUMN execution_trusted')
    const migrated = new Ledger(dbPath); ledgers.push(migrated)
    expect(migrated.getBuild(build.id)?.executionTrusted).toBe(false)
    const portable = new DatabaseSync(portablePath, { readOnly: true })
    expect(portable.prepare('SELECT execution_trusted FROM builds').get()?.execution_trusted).toBe(0)
    portable.close()
  })

  it('strips portable execution consent on import to a second registry', async () => {
    const { ledger, build, root, invoke } = setup()
    expect(await invoke().result).toMatchObject({ ok: true })
    ledger.prepareBuildFolder(build.id)
    const imported = new Ledger(path.join(root, 'second.db')); ledgers.push(imported)
    imported.importBuildFolder(build.workspaceDir)
    expect(imported.getBuild(build.id)).toMatchObject({ playTrusted: false, executionTrusted: false })
  })

  it.each(['Play', 'Resume'])('%s only continues after confirmed, persisted trust', async (entry) => {
    const { ledger, build } = setup()
    for (const response of [0, 1]) {
      const action = vi.fn(async (id: string) => {
        expect(id).toBe(build.id)
        expect(ledger.getBuild(id)?.executionTrusted).toBe(true)
        return entry
      })
      const trust = (id: string) => trustExistingBuild(ledger, id, async () => ({ response }), vi.fn(), () => false)
      await withExistingBuildTrust(build, trust, () => true, action)
      expect(action).toHaveBeenCalledTimes(response)
    }
  })
})
