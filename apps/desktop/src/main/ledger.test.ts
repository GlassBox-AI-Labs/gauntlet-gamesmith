import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { defaultLoopTitle, Ledger } from './ledger'

const models = resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'claude-opus-5', subagentEffort: 'medium' }, DEFAULT_CRITIC)

let dir: string | null = null

function makeLedger(): Ledger {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-ledger-'))
  return new Ledger(path.join(dir, 'ledger.db'))
}

function workspace(name = 'workspace'): string {
  if (!dir) throw new Error('Test ledger has not been created.')
  const workspaceDir = path.join(dir, name)
  fs.mkdirSync(workspaceDir, { recursive: true })
  return workspaceDir
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('Ledger', () => {
  it('derives concise, tasteful run titles from prompts', () => {
    expect(defaultLoopTitle('Build "Pac-Claude" — a modern AAA game')).toBe('Pac-claude')
    expect(defaultLoopTitle('Create a polished authentication flow: include passkeys')).toBe('A polished authentication flow')
  })

  it('round-trips loops, runs, verdicts and metrics', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'build it', workspaceDir: workspace(), maxRounds: 5, budgetUsd: 50, models })
    expect(loop.status).toBe('running')
    expect(loop.title).toBe('It')
    expect(loop.models.criticModel).toBe('gpt-5.6-sol')

    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'p1' })
    expect(ledger.nextQueuedRun(loop.id)!.id).toBe(run.id)

    ledger.patchRun(run.id, {
      status: 'succeeded',
      revision: '0123456789abcdef0123456789abcdef01234567',
      costUsd: 4.2,
      verdict: { score: 0.4, pass: false, summary: 's', findings: [{ severity: 'major', text: 'f' }] },
      metrics: { agents: [{ id: 'orchestrator', label: 'orchestrator', model: 'claude-fable-5', messages: 3, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, firstTs: null, lastTs: null }], perModel: {} },
    })
    const saved = ledger.getRun(run.id)!
    expect(saved.status).toBe('succeeded')
    expect(saved.revision).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(saved.verdict!.findings[0].text).toBe('f')
    expect(saved.metrics!.agents[0].messages).toBe(3)
    expect(ledger.nextQueuedRun(loop.id)).toBeNull()

    ledger.patchLoop(loop.id, { status: 'passed', totalCostUsd: 4.2, stopReason: 'done' })
    expect(ledger.latestLoop()!.status).toBe('passed')
    expect(ledger.runningLoop()).toBeNull()
    ledger.close()
  })

  it('persists an operator-supplied run title', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'Build a game', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    ledger.patchLoop(loop.id, { title: 'Arcade study' })

    expect(ledger.getLoop(loop.id)?.title).toBe('Arcade study')
    ledger.close()
  })

  it('appends and reads back events in order', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: workspace(), maxRounds: 1, budgetUsd: null, models })
    for (let i = 0; i < 5; i += 1) ledger.appendEvent({ loopId: loop.id, runId: null, ts: `t${i}`, kind: 'system', text: `line ${i}` })
    const lines = ledger.eventsForLoop(loop.id, 3)
    expect(lines.map((l) => l.text)).toEqual(['line 2', 'line 3', 'line 4'])
    ledger.close()
  })

  it('lists every run with the newest prompt first', () => {
    const ledger = makeLedger()
    const first = ledger.createLoop({ prompt: 'first', workspaceDir: workspace('one'), maxRounds: 1, budgetUsd: null, models })
    const second = ledger.createLoop({ prompt: 'second', workspaceDir: workspace('two'), maxRounds: 1, budgetUsd: null, models })

    expect(ledger.loops().map((loop) => loop.id)).toEqual([second.id, first.id])
    ledger.close()
  })

  it('requeues an orphaned run with the resume marker', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: workspace(), maxRounds: 3, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 2, role: 'implement', harness: 'claude', prompt: 'build it' })
    ledger.patchRun(run.id, { status: 'running' })

    const requeued = ledger.requeueInterruptedRun(ledger.getRun(run.id)!)
    expect(ledger.getRun(run.id)!.status).toBe('interrupted')
    expect(ledger.getLoop(loop.id)!.status).toBe('running')
    expect(requeued.round).toBe(2)
    expect(requeued.status).toBe('queued')
    expect(requeued.prompt).toBe('[[gauntlet:resume]]\nbuild it')
    // Requeuing the requeued run must not stack markers.
    const again = ledger.requeueInterruptedRun(requeued)
    expect(again.prompt).toBe('[[gauntlet:resume]]\nbuild it')
    expect(ledger.runningLoops().map((l) => l.id)).toEqual([loop.id])
    ledger.close()
  })
})
