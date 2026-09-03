import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { Ledger } from './ledger'
import { LoopRunner } from './loop-runner'

/**
 * Which phase a resume picks up from.
 *
 * A failed Asset Build is tolerated on purpose, so a usage limit can end the
 * assets run and fail the implement run behind it. Resuming at the last run
 * then rebuilds the game around a half-built cast — the case this covers.
 */

const models = resolveModels({ orchestratorModel: 'claude-fable-5-1' }, DEFAULT_CRITIC)

let dir: string

interface Harness {
  runner: LoopRunner
  ledger: Ledger
  loopId: string
}

function setup(): Harness {
  const workspaceDir = path.join(dir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  const ledger = new Ledger(path.join(dir, 'ledger.db'))
  const loop = ledger.createLoop({ prompt: 'build it', workspaceDir, maxRounds: 3, budgetUsd: null, models })
  const runner = new LoopRunner(ledger, () => {}, async () => ({ ok: false, from: 'test' }))
  return { runner, ledger, loopId: loop.id }
}

function add(h: Harness, round: number, role: 'assets' | 'implement' | 'critique' | 'reference', status: string) {
  const run = h.ledger.createRun({ loopId: h.loopId, round, role, harness: 'claude', prompt: `${role} prompt` })
  h.ledger.patchRun(run.id, { status: status as never })
  return run
}

function target(h: Harness, round: number) {
  return (
    h.runner as unknown as { resumeTarget: (id: string, r: number) => { role: string; id: string } | null }
  ).resumeTarget(h.loopId, round)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-resume-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('resume target', () => {
  it('goes back to the assets phase when it failed before the implement run did', () => {
    const h = setup()
    add(h, 1, 'assets', 'cancelled')
    add(h, 1, 'assets', 'failed')
    add(h, 1, 'implement', 'failed')

    // Not the implement run, which is what resuming used to retry.
    expect(target(h, 1)?.role).toBe('assets')
  })

  it('retries the most recent attempt of that phase, not the first', () => {
    const h = setup()
    add(h, 1, 'assets', 'cancelled')
    const second = add(h, 1, 'assets', 'failed')
    add(h, 1, 'implement', 'failed')

    expect(target(h, 1)?.id).toBe(second.id)
  })

  it('moves on to the implement run once the assets phase has succeeded', () => {
    const h = setup()
    add(h, 1, 'assets', 'failed')
    add(h, 1, 'assets', 'succeeded')
    add(h, 1, 'implement', 'failed')

    expect(target(h, 1)?.role).toBe('implement')
  })

  it('skips a phase that never ran at all', () => {
    const h = setup()
    add(h, 1, 'implement', 'failed')

    expect(target(h, 1)?.role).toBe('implement')
  })

  it('reaches the critique only when the phases before it are done', () => {
    const h = setup()
    add(h, 1, 'assets', 'succeeded')
    add(h, 1, 'implement', 'succeeded')
    add(h, 1, 'critique', 'failed')

    expect(target(h, 1)?.role).toBe('critique')
  })

  it('has nothing to resume when the whole round succeeded', () => {
    const h = setup()
    add(h, 1, 'assets', 'succeeded')
    add(h, 1, 'implement', 'succeeded')

    expect(target(h, 1)).toBeNull()
  })

  it('ignores other rounds', () => {
    const h = setup()
    add(h, 1, 'assets', 'failed')
    add(h, 2, 'implement', 'failed')

    expect(target(h, 2)?.role).toBe('implement')
  })

  it('finds no phase order in round 0, leaving the reference run as its own target', () => {
    const h = setup()
    add(h, 0, 'reference', 'failed')

    expect(target(h, 0)).toBeNull()
  })
})
