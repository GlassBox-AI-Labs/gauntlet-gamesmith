import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LoopModels } from '../shared/loop'
import { Ledger } from './ledger'

const models: LoopModels = {
  orchestratorModel: 'claude-fable-5',
  orchestratorEffort: 'high',
  subagentModel: 'opus',
  subagentEffort: 'medium',
  criticModel: 'gpt-5.6-sol',
  criticEffort: 'medium',
}

let dir: string | null = null

function makeLedger(): Ledger {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-ledger-'))
  return new Ledger(path.join(dir, 'ledger.db'))
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('Ledger', () => {
  it('round-trips loops, runs, verdicts and metrics', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'build it', workspaceDir: '/tmp/w', maxRounds: 5, budgetUsd: 50, models })
    expect(loop.status).toBe('running')
    expect(loop.models.criticModel).toBe('gpt-5.6-sol')

    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'p1' })
    expect(ledger.nextQueuedRun(loop.id)!.id).toBe(run.id)

    ledger.patchRun(run.id, {
      status: 'succeeded',
      costUsd: 4.2,
      verdict: { score: 0.4, pass: false, summary: 's', findings: [{ severity: 'major', text: 'f' }] },
      metrics: { agents: [{ id: 'orchestrator', label: 'orchestrator', model: 'claude-fable-5', messages: 3, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, firstTs: null, lastTs: null }], perModel: {} },
    })
    const saved = ledger.getRun(run.id)!
    expect(saved.status).toBe('succeeded')
    expect(saved.verdict!.findings[0].text).toBe('f')
    expect(saved.metrics!.agents[0].messages).toBe(3)
    expect(ledger.nextQueuedRun(loop.id)).toBeNull()

    ledger.patchLoop(loop.id, { status: 'passed', totalCostUsd: 4.2, stopReason: 'done' })
    expect(ledger.latestLoop()!.status).toBe('passed')
    expect(ledger.runningLoop()).toBeNull()
    ledger.close()
  })

  it('appends and reads back events in order', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: '/tmp/w', maxRounds: 1, budgetUsd: null, models })
    for (let i = 0; i < 5; i += 1) ledger.appendEvent({ loopId: loop.id, runId: null, ts: `t${i}`, kind: 'system', text: `line ${i}` })
    const lines = ledger.eventsForLoop(loop.id, 3)
    expect(lines.map((l) => l.text)).toEqual(['line 2', 'line 3', 'line 4'])
    ledger.close()
  })

  it('resumes running loops from a dead session by requeuing the interrupted run', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: '/tmp/w', maxRounds: 3, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 2, role: 'implement', harness: 'claude', prompt: 'build it' })
    ledger.patchRun(run.id, { status: 'running' })

    const resumed = ledger.resumeRunningLoops()
    expect(resumed).toEqual([{ loopId: loop.id, round: 2, role: 'implement' }])
    expect(ledger.getRun(run.id)!.status).toBe('interrupted')
    expect(ledger.getLoop(loop.id)!.status).toBe('running')
    const requeued = ledger.nextQueuedRun(loop.id)!
    expect(requeued.round).toBe(2)
    expect(requeued.prompt).toBe('[[gauntlet:resume]]\nbuild it')
    ledger.close()
  })

  it('stops a running loop with no pending work after restart', () => {
    const ledger = makeLedger()
    const loop = ledger.createLoop({ prompt: 'p', workspaceDir: '/tmp/w', maxRounds: 1, budgetUsd: null, models })
    expect(ledger.resumeRunningLoops()).toEqual([])
    expect(ledger.getLoop(loop.id)!.status).toBe('stopped')
    ledger.close()
  })
})
