import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PRIMARY_ACCOUNT_ID } from '../../shared/harness'
import { DEFAULT_CRITIC, resolveModels } from '../../shared/models'
import { addAccount, prepareAccountDir, sharedDir } from '../accounts'
import { observeChildStreams } from '../child-agents'
import { Ledger } from '../ledger'
import { createClaudeImplementProtocol } from './implement-claude'

/**
 * Every account but the first reaches session transcripts through a `projects`
 * symlink into the shared store, and the workflow path walker refuses to follow
 * one. Reading live workflow progress from the active account's dir therefore
 * threw on the first poll, which run supervision turned into a killed run.
 */

const models = resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'claude-sonnet-5', subagentEffort: 'high' }, DEFAULT_CRITIC)

let dir: string | null = null

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('workflow polling with a second account', () => {
  it('reads transcripts from the shared store, not the linked account dir', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-implement-claude-'))
    const workspaceDir = path.join(dir, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    const harnesses = path.join(dir, 'harnesses')
    prepareAccountDir(harnesses, 'claude', PRIMARY_ACCOUNT_ID)
    const second = addAccount(harnesses, 'claude').activeId
    const accountHome = prepareAccountDir(harnesses, 'claude', second)
    expect(fs.lstatSync(path.join(accountHome, 'projects')).isSymbolicLink()).toBe(true)

    // Token flushing — and with it the workflow poll — is throttled to 15s.
    let clock = 0
    const ledger = new Ledger(path.join(dir, 'ledger.db'))
    const loop = ledger.createLoop({ prompt: 'build it', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })
    const parser = createClaudeImplementProtocol({
      ledger,
      loop: ledger.getLoop(loop.id)!,
      run: ledger.getRun(run.id)!,
      gate: { suppress: false },
      childBoundary: observeChildStreams(workspaceDir),
      now: () => clock,
      nowIso: () => new Date().toISOString(),
      harnessHome: () => accountHome,
      harnessSharedHome: () => sharedDir(harnesses, 'claude'),
      log: () => {},
      broadcast: () => {},
      finalize: async () => {},
    })

    parser.onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-fable-5' }))
    expect(ledger.getRun(run.id)?.sessionId).toBe('sess-1')
    clock = 60_000
    // The first poll is what used to throw `path component is a symbolic link`.
    expect(() => parser.onLine(JSON.stringify({
      type: 'assistant',
      message: { id: 'm1', model: 'claude-fable-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    }))).not.toThrow()
  })
})
