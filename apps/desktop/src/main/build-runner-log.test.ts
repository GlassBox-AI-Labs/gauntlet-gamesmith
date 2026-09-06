import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BuildLogLine } from '../shared/build'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { Ledger } from './ledger'
import { BuildRunner } from './build-runner'

const models = resolveModels({ orchestratorModel: 'claude-fable-5' }, DEFAULT_CRITIC)

let dir: string | null = null

function makeHarness(): { ledger: Ledger; runner: BuildRunner; sent: BuildLogLine[]; workspaceDir: string } {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-log-'))
  const workspaceDir = path.join(dir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  const ledger = new Ledger(path.join(dir, 'ledger.db'))
  const sent: BuildLogLine[] = []
  const runner = new BuildRunner(
    ledger,
    (channel, payload) => {
      if (channel === 'build:log') sent.push(payload as BuildLogLine)
    },
    async () => ({ ok: false, from: 'test' }),
  )
  return { ledger, runner, sent, workspaceDir }
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('log stamping', () => {
  it('stamps round, role, and channel from the build, and agentId when given', () => {
    const { ledger, runner, sent, workspaceDir } = makeHarness()
    const build = ledger.createBuild({ prompt: 'build it', workspaceDir, maxRounds: 5, budgetUsd: null, models })
    const reference = ledger.createAttempt({ buildId: build.id, round: 0, role: 'reference', harness: 'claude', prompt: 'study' })
    const implement = ledger.createAttempt({ buildId: build.id, round: 2, role: 'implement', harness: 'claude', prompt: 'round 2' })

    runner['log'](build.id, reference.id, 'search', '⌕ boss arenas', 'researcher-1')
    runner['log'](build.id, implement.id, 'claude', 'Slices dispatched.')
    runner['log'](build.id, null, 'system', 'Build started.')

    expect(sent[0]).toMatchObject({ attemptId: reference.id, round: 0, role: 'reference', channel: 'search', agentId: 'researcher-1' })
    expect(sent[1]).toMatchObject({ attemptId: implement.id, round: 2, role: 'implement', channel: 'output' })
    expect(sent[1].agentId).toBeUndefined()
    expect(sent[2].round).toBeUndefined()
    expect(sent[2].role).toBeUndefined()
    expect(sent[2].channel).toBe('system')

    // The stamped fields round-trip through the ledger unchanged.
    expect(ledger.eventsForBuild(build.id)).toEqual(sent)
    ledger.close()
  })

  it('backfills round, role, and channel for legacy rows at read time', () => {
    const { ledger, workspaceDir } = makeHarness()
    const build = ledger.createBuild({ prompt: 'build it', workspaceDir, maxRounds: 5, budgetUsd: null, models })
    const critique = ledger.createAttempt({ buildId: build.id, round: 3, role: 'critique', harness: 'codex', prompt: 'judge' })
    // A pre-schema row: no agentId, round, role, or channel was ever written.
    ledger.appendEvent({ buildId: build.id, attemptId: critique.id, ts: new Date().toISOString(), kind: 'verdict', text: 'Score 0.81' })

    const [line] = ledger.eventsForBuild(build.id)
    expect(line).toMatchObject({ attemptId: critique.id, kind: 'verdict', round: 3, role: 'critique', channel: 'output' })
    expect(line.agentId).toBeUndefined()
    const [forAttempt] = ledger.eventsForAttempt(critique.id)
    expect(forAttempt).toMatchObject({ round: 3, role: 'critique', channel: 'output' })
    ledger.close()
  })
})
