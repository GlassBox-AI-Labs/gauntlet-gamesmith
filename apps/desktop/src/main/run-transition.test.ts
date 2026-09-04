import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveModels } from '../shared/models'
import { Ledger } from './ledger'
import { commitRunningAttempt } from './run-transition'

const roots: string[] = []
const ledgers: Ledger[] = []

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('commitRunningAttempt', () => {
  it('charges and creates a successor only once when finalization is replayed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-transition-'))
    roots.push(root)
    const ledger = new Ledger(path.join(root, 'ledger.db'))
    ledgers.push(ledger)
    const models = resolveModels({}, {}, {})
    const loop = ledger.createLoop({ prompt: 'build', workspaceDir: root, maxRounds: 2, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'implement' })
    ledger.patchRun(run.id, { status: 'running', costUsd: 1.25 })

    const finalize = (): boolean => commitRunningAttempt(ledger, loop.id, run.id, { status: 'succeeded' }, () => {
      ledger.appendEvent({
        loopId: loop.id,
        runId: run.id,
        ts: new Date(0).toISOString(),
        kind: 'metric',
        channel: 'usage',
        text: 'terminal accounting',
      })
      ledger.createRun({ loopId: loop.id, round: 1, role: 'critique', harness: 'claude', prompt: 'judge' })
    })

    expect(finalize()).toBe(true)
    expect(finalize()).toBe(false)
    expect(ledger.getLoop(loop.id)?.totalCostUsd).toBe(1.25)
    expect(ledger.runsForLoop(loop.id).map((item) => item.role)).toEqual(['implement', 'critique'])
    expect(ledger.eventsForRun(run.id, 'metric')).toHaveLength(1)
    expect(ledger.getRun(run.id)?.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it.each(['failed', 'cancelled', 'interrupted'] as const)('stamps finishedAt for a %s terminal transition', (status) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-transition-'))
    roots.push(root)
    const ledger = new Ledger(path.join(root, 'ledger.db'))
    ledgers.push(ledger)
    const loop = ledger.createLoop({ prompt: 'build', workspaceDir: root, maxRounds: 1, budgetUsd: null, models: resolveModels({}, {}, {}) })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'implement' })
    ledger.patchRun(run.id, { status: 'running' })

    expect(commitRunningAttempt(ledger, loop.id, run.id, { status })).toBe(true)
    expect(ledger.getRun(run.id)?.finishedAt).not.toBeNull()
  })
})
