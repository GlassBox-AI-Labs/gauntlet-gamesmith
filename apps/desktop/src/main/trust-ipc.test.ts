import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { playAccessError } from './play'
import { Ledger } from './ledger'
import { trustExistingRun } from './trust-ipc'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { rawStreamTrustError } from './raw-streams'
import { withExistingRunTrust } from '../renderer/src/lib/trusted-action'

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
  const loop = ledger.createLoop({ prompt: 'An existing game', workspaceDir, maxRounds: 2, budgetUsd: null,
    models: resolveModels({ orchestratorModel: 'gpt-5.6-sol', orchestratorEffort: 'high', subagentModel: null, subagentEffort: 'medium' }, DEFAULT_CRITIC) })
  ledger.patchLoop(loop.id, { status: 'stopped', playTrusted: false })
  const portablePath = path.join(workspaceDir, '.gauntlet-gamesmith', 'ledger.db')
  const invoke = (dialog = vi.fn(async () => ({ response: 1 })), active = () => false) => {
    const notify = vi.fn()
    return { dialog, notify, result: trustExistingRun(ledger, loop.id, dialog, notify, active) }
  }
  return { root, ledger, loop: ledger.getLoop(loop.id)!, dbPath, portablePath, invoke }
}
function sql(file: string, statement: string) {
  const db = new DatabaseSync(file)
  try { db.exec(statement) } finally { db.close() }
}
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('existing-run trust boundary', () => {
  it('uses a native warning with exact title/path, Cancel default and escape, and durable consent in both ledgers', async () => {
    const { ledger, loop, portablePath, dbPath, invoke } = setup()
    const { result, dialog, notify } = invoke()
    expect(await result).toMatchObject({ ok: true, value: { id: loop.id, executionTrusted: true, playTrusted: false } })
    expect(dialog).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', buttons: ['Cancel', 'Trust run & folder'], defaultId: 0, cancelId: 0,
      detail: expect.stringContaining(`Run: ${loop.title}\nFolder: ${loop.workspaceDir}`) }))
    expect(dialog).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('local user permissions') }))
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: loop.id }), expect.objectContaining({ kind: 'trust', channel: 'system', text: expect.stringContaining('Operator explicitly trusted') }))
    for (const file of [dbPath, portablePath]) {
      const db = new DatabaseSync(file, { readOnly: true })
      expect(db.prepare('SELECT execution_trusted, play_trusted FROM loops WHERE id = ?').get(loop.id)).toMatchObject({ execution_trusted: 1, play_trusted: 0 })
      expect(db.prepare("SELECT text FROM events WHERE kind = 'trust'").get()?.text).toContain(loop.workspaceDir)
      db.close()
    }
    expect(rawStreamTrustError(ledger.getLoop(loop.id)!.playTrusted)).not.toBeNull()
    expect(playAccessError(loop)).not.toBeNull()
    expect(playAccessError(ledger.getLoop(loop.id)!)).toBeNull()
    ledger.close(); ledgers.splice(ledgers.indexOf(ledger), 1)
    const reopened = new Ledger(dbPath); ledgers.push(reopened)
    expect(reopened.getLoop(loop.id)?.executionTrusted).toBe(true)
  })

  it.each([0, -1, 2])('cancels safely for native response %s', async (response) => {
    const { ledger, loop, invoke } = setup()
    const { result, notify } = invoke(vi.fn(async () => ({ response })))
    expect(await result).toEqual({ ok: true, value: null })
    expect(ledger.getLoop(loop.id)?.executionTrusted).toBe(false)
    expect(ledger.eventsForLoop(loop.id)).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })

  it('validates unknown IPC values before showing a dialog', async () => {
    const { ledger } = setup()
    const dialog = vi.fn()
    for (const value of [null, {}, { loopId: 'x', trusted: true }, '../game', 42]) {
      expect(await trustExistingRun(ledger, value, dialog, vi.fn(), () => false)).toMatchObject({ ok: false })
    }
    expect(dialog).not.toHaveBeenCalled()
  })

  it.each(['path', 'history', 'active', 'ownership', 'quarantine', 'protected', 'identity'])('rejects %s problems before prompting', async (kind) => {
    const protectedRoots: string[] = []
    const { ledger, loop, dbPath, portablePath, invoke } = setup(protectedRoots)
    if (kind === 'path') sql(dbPath, "UPDATE loops SET workspace_dir = workspace_dir || '/moved'")
    if (kind === 'history') sql(portablePath, "UPDATE loops SET prompt = 'replaced prompt'")
    if (kind === 'active') ledger.patchLoop(loop.id, { status: 'running' })
    if (kind === 'ownership' || kind === 'quarantine') {
      const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'go' })
      if (kind === 'ownership') sql(dbPath, "UPDATE runs SET process_ownership_json = '{}'")
      else ledger.patchRun(run.id, { error: 'Launch identity was not durably recorded before the app exited. unknown writer' })
    }
    if (kind === 'protected') protectedRoots.push(loop.workspaceDir)
    if (kind === 'identity') sql(dbPath, 'UPDATE loops SET workspace_ino = workspace_ino + 1')
    const { result, dialog } = invoke()
    expect(await result).toMatchObject({ ok: false })
    expect(dialog).not.toHaveBeenCalled()
    expect(ledger.getLoop(loop.id)?.executionTrusted).toBe(false)
  })

  it.each(['title', 'history', 'script', 'path', 'identity', 'active', 'play'])('rejects %s changes while the dialog is open', async (kind) => {
    const { ledger, loop, dbPath, portablePath, invoke } = setup()
    let activePlay = false
    const { result } = invoke(vi.fn(async () => {
      if (kind === 'title') sql(dbPath, "UPDATE loops SET title = 'Different title'")
      if (kind === 'history') sql(portablePath, "UPDATE loops SET max_rounds = 3")
      if (kind === 'script') fs.writeFileSync(path.join(loop.workspaceDir, 'game.js'), 'changed')
      if (kind === 'path') sql(dbPath, "UPDATE loops SET workspace_dir = workspace_dir || '/changed'")
      if (kind === 'identity') sql(dbPath, 'UPDATE loops SET workspace_ino = workspace_ino + 1')
      if (kind === 'active') ledger.patchLoop(loop.id, { status: 'running' })
      if (kind === 'play') activePlay = true
      return { response: 1 }
    }), () => activePlay)
    expect(await result).toMatchObject({ ok: false })
    expect(ledger.getLoop(loop.id)?.executionTrusted).toBe(false)
  })

  it('rejects changed attempt/event history and executable portable schema', async () => {
    for (const mutation of [
      "UPDATE runs SET session_id = 'another-private-session'",
      "UPDATE events SET text = 'changed history'",
      "CREATE TRIGGER unexpected AFTER UPDATE ON loops BEGIN DELETE FROM events; END",
    ]) {
      const { ledger, loop, portablePath, invoke } = setup()
      ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'go' })
      ledger.appendEvent({ loopId: loop.id, runId: null, ts: new Date().toISOString(), kind: 'system', text: 'original' })
      sql(portablePath, mutation)
      const { result, dialog } = invoke()
      expect(await result).toMatchObject({ ok: false })
      expect(dialog).not.toHaveBeenCalled()
    }
  })

  it('rejects a replaced portable ledger even with identical contents while confirmation is open', async () => {
    const { ledger, loop, portablePath, invoke } = setup()
    const { result } = invoke(vi.fn(async () => {
      const replacement = `${portablePath}.replacement`
      fs.copyFileSync(portablePath, replacement)
      fs.renameSync(replacement, portablePath)
      return { response: 1 }
    }))
    expect(await result).toMatchObject({ ok: false })
    expect(ledger.getLoop(loop.id)?.executionTrusted).toBe(false)
  })

  it('rejects external links without reading their target contents', async () => {
    const { root, loop, invoke } = setup()
    const target = path.join(root, 'external')
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(loop.workspaceDir, 'linked-directory'))
    const { result, dialog } = invoke()
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('outside') })
    expect(dialog).not.toHaveBeenCalled()
  })

  it('does not prompt for new locally trusted runs', async () => {
    const { ledger, loop, invoke } = setup()
    ledger.patchLoop(loop.id, { playTrusted: true })
    const { result, dialog } = invoke()
    expect(await result).toMatchObject({ ok: true, value: { playTrusted: true } })
    expect(dialog).not.toHaveBeenCalled()
  })

  it.each(['before-commit', 'after-commit'])('revokes execution trust on %s persistence failure and never continues Play', async (when) => {
    const { ledger, loop, portablePath } = setup()
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
    await expect(withExistingRunTrust(loop,
      (id) => trustExistingRun(ledger, id, async () => ({ response: 1 }), vi.fn(), () => false),
      () => true, play)).rejects.toThrow(/fail/)
    expect(play).not.toHaveBeenCalled()
    expect(ledger.getLoop(loop.id)?.executionTrusted).toBe(false)
    const portable = new DatabaseSync(portablePath, { readOnly: true })
    expect(portable.prepare('SELECT execution_trusted FROM loops').get()?.execution_trusted).toBe(0)
    portable.close()
    expect(ledger.eventsForLoop(loop.id).at(-1)?.text).toContain('execution trust was revoked')
  })

  it('trusts only the run named in the dialog when a folder contains multiple histories', async () => {
    const { ledger, loop, invoke } = setup()
    const sibling = ledger.createLoop({ prompt: 'Sibling game', workspaceDir: loop.workspaceDir, maxRounds: 2, budgetUsd: null, models: loop.models })
    ledger.patchLoop(sibling.id, { status: 'stopped', playTrusted: false })
    expect(await invoke().result).toMatchObject({ ok: true })
    expect(ledger.getLoop(loop.id)?.executionTrusted).toBe(true)
    expect(ledger.getLoop(sibling.id)?.executionTrusted).toBe(false)
  })

  it('migrates the previous schema with execution trust denied in both ledgers', () => {
    const { ledger, loop, dbPath, portablePath } = setup()
    ledger.close(); ledgers.splice(ledgers.indexOf(ledger), 1)
    for (const file of [dbPath, portablePath]) sql(file, 'ALTER TABLE loops DROP COLUMN execution_trusted')
    const migrated = new Ledger(dbPath); ledgers.push(migrated)
    expect(migrated.getLoop(loop.id)?.executionTrusted).toBe(false)
    const portable = new DatabaseSync(portablePath, { readOnly: true })
    expect(portable.prepare('SELECT execution_trusted FROM loops').get()?.execution_trusted).toBe(0)
    portable.close()
  })

  it('strips portable execution consent on import to a second registry', async () => {
    const { ledger, loop, root, invoke } = setup()
    expect(await invoke().result).toMatchObject({ ok: true })
    ledger.prepareRunFolder(loop.id)
    const imported = new Ledger(path.join(root, 'second.db')); ledgers.push(imported)
    imported.importRunFolder(loop.workspaceDir)
    expect(imported.getLoop(loop.id)).toMatchObject({ playTrusted: false, executionTrusted: false })
  })

  it.each(['Play', 'Resume'])('%s only continues after confirmed, persisted trust', async (entry) => {
    const { ledger, loop } = setup()
    for (const response of [0, 1]) {
      const action = vi.fn(async (id: string) => {
        expect(id).toBe(loop.id)
        expect(ledger.getLoop(id)?.executionTrusted).toBe(true)
        return entry
      })
      const trust = (id: string) => trustExistingRun(ledger, id, async () => ({ response }), vi.fn(), () => false)
      await withExistingRunTrust(loop, trust, () => true, action)
      expect(action).toHaveBeenCalledTimes(response)
    }
  })
})
