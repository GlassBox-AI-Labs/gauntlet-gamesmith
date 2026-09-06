import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveModels } from '../shared/models'
import { Ledger } from './ledger'
import { commitRunningAttempt } from './attempt-transition'

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
    const build = ledger.createBuild({ prompt: 'build', workspaceDir: root, maxRounds: 2, budgetUsd: null, models })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'codex', prompt: 'implement' })
    ledger.patchAttempt(attempt.id, { status: 'running', costUsd: 1.25 })

    const finalize = (): boolean => commitRunningAttempt(ledger, build.id, attempt.id, { status: 'succeeded' }, () => {
      ledger.appendEvent({
        buildId: build.id,
        attemptId: attempt.id,
        ts: new Date(0).toISOString(),
        kind: 'metric',
        channel: 'usage',
        text: 'terminal accounting',
      })
      ledger.createAttempt({ buildId: build.id, round: 1, role: 'critique', harness: 'claude', prompt: 'judge' })
    })

    expect(finalize()).toBe(true)
    expect(finalize()).toBe(false)
    expect(ledger.getBuild(build.id)?.totalCostUsd).toBe(1.25)
    expect(ledger.attemptsForBuild(build.id).map((item) => item.role)).toEqual(['implement', 'critique'])
    expect(ledger.eventsForAttempt(attempt.id, 'metric')).toHaveLength(1)
    expect(ledger.getAttempt(attempt.id)?.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it.each(['failed', 'cancelled', 'interrupted'] as const)('stamps finishedAt for a %s terminal transition', (status) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-transition-'))
    roots.push(root)
    const ledger = new Ledger(path.join(root, 'ledger.db'))
    ledgers.push(ledger)
    const build = ledger.createBuild({ prompt: 'build', workspaceDir: root, maxRounds: 1, budgetUsd: null, models: resolveModels({}, {}, {}) })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'codex', prompt: 'implement' })
    ledger.patchAttempt(attempt.id, { status: 'running' })

    expect(commitRunningAttempt(ledger, build.id, attempt.id, { status })).toBe(true)
    expect(ledger.getAttempt(attempt.id)?.finishedAt).not.toBeNull()
  })
})
