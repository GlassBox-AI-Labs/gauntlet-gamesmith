import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AccountRotation, HarnessKind } from '../shared/harness'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { Ledger } from './ledger'
import { BuildRunner } from './build-runner'

/**
 * A usage limit ends the account's window, not the work. These cover the
 * decision to move to another account and retry, which is the whole reason a
 * long build can outlive one subscription's five-hour ceiling.
 */

const models = resolveModels({ orchestratorModel: 'claude-fable-5' }, DEFAULT_CRITIC)
const LIMIT = "You've hit your session limit · resets 3:20am (America/Chicago)"

let dir: string

interface Harness {
  runner: BuildRunner
  ledger: Ledger
  buildId: string
  attemptId: string
  asked: HarnessKind[]
}

function setup(rotation: AccountRotation): Harness {
  const workspaceDir = path.join(dir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  const ledger = new Ledger(path.join(dir, 'ledger.db'))
  const build = ledger.createBuild({ prompt: 'build it', workspaceDir, maxRounds: 3, budgetUsd: null, models })
  const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })
  const asked: HarnessKind[] = []
  const runner = new BuildRunner(ledger, () => {}, async (kind) => {
    asked.push(kind)
    return rotation
  })
  return { runner, ledger, buildId: build.id, attemptId: attempt.id, asked }
}

function rotate(h: Harness, error: string): Promise<{ rotated: boolean; message?: string | null }> {
  const build = h.ledger.getBuild(h.buildId)!
  const attempt = h.ledger.getAttempt(h.attemptId)!
  return (
    h.runner as unknown as {
      rotateForUsageLimit: (l: typeof build, r: typeof attempt, e: string) => Promise<{ rotated: boolean; message?: string | null }>
    }
  ).rotateForUsageLimit(build, attempt, error)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-rotation-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('usage-limit account rotation', () => {
  it('moves to the next account when the limit is hit', async () => {
    const h = setup({ ok: true, from: 'first@example.com', to: 'second@example.com' })

    expect(await rotate(h, LIMIT)).toEqual({ rotated: true })
    expect(h.asked).toEqual(['claude'])
  })

  it('leaves an ordinary failure alone', async () => {
    const h = setup({ ok: true, from: 'first@example.com', to: 'second@example.com' })
    const outcome = await rotate(h, 'TypeError: cannot read property of undefined')

    expect(outcome).toEqual({ rotated: false, message: null })
    // The whole point of the regex gate: a crash must not burn an account.
    expect(h.asked).toEqual([])
  })

  it('recognises the wordings both CLIs use', async () => {
    for (const error of [
      // The wording Claude Code actually prints, observed ending a real build
      // because the first version of the pattern did not match it.
      "You've hit your session limit · resets 3:20am (America/Chicago)",
      'rate limit exceeded',
      'rate-limited',
      'Usage limit reached',
      'weekly limit reached',
      'out of extra usage',
    ]) {
      const h = setup({ ok: true, from: 'a', to: 'b' })

      expect((await rotate(h, error)).rotated).toBe(true)
    }
  })

  it('says what to do when no other account can take over', async () => {
    const h = setup({ ok: false, from: 'first@example.com', reason: 'no other account is set up' })
    const outcome = await rotate(h, LIMIT)

    expect(outcome.rotated).toBe(false)
    expect(outcome.message).toContain('first@example.com')
    expect(outcome.message).toContain('no other account is set up')
    expect(outcome.message).toContain('Agents tab')
  })

  it('stops after a few rotations rather than walking every account', async () => {
    const h = setup({ ok: true, from: 'a', to: 'b' })
    for (let i = 0; i < 3; i += 1) expect((await rotate(h, LIMIT)).rotated).toBe(true)

    const capped = await rotate(h, LIMIT)

    expect(capped.rotated).toBe(false)
    expect(capped.message).toContain('changing accounts 3 time(s)')
    expect(h.asked).toHaveLength(3)
  })

  it('gives a finished build its rotation budget back', async () => {
    const h = setup({ ok: true, from: 'a', to: 'b' })
    for (let i = 0; i < 3; i += 1) await rotate(h, LIMIT)
    ;(h.runner as unknown as { finishBuild: (id: string, s: string, r: string) => void }).finishBuild(
      h.buildId,
      'stopped',
      'done',
    )

    expect((await rotate(h, LIMIT)).rotated).toBe(true)
  })

  it('waits for the first window to reopen instead of ending the build', async () => {
    const resetAt = Date.now() + 30 * 60 * 1000
    const h = setup({ ok: false, from: 'first@example.com', reason: 'all spent', resetAt })
    const outcome = (await rotate(h, LIMIT)) as { rotated: boolean; waitMs?: number }

    expect(outcome.rotated).toBe(true)
    expect(outcome.waitMs).toBeGreaterThan(29 * 60 * 1000)
    expect(outcome.waitMs).toBeLessThanOrEqual(30 * 60 * 1000)
  })

  it('gives up rather than waiting out an implausibly long window', async () => {
    const resetAt = Date.now() + 9 * 60 * 60 * 1000
    const h = setup({ ok: false, from: 'first@example.com', reason: 'all spent', resetAt })
    const outcome = await rotate(h, LIMIT)

    expect(outcome.rotated).toBe(false)
    expect(outcome.message).toContain('all spent')
  })

  it('does not wait when a reset time is already past', async () => {
    const h = setup({ ok: false, from: 'a', reason: 'all spent', resetAt: Date.now() - 1000 })

    expect((await rotate(h, LIMIT)).rotated).toBe(false)
  })
})
