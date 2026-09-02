import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { Ledger } from './ledger'
import { LoopRunner } from './loop-runner'

/**
 * Backgrounded subagents answer the Agent tool within a millisecond ("launched")
 * and only finish much later via system/task_notification. The parser used to
 * read that launch receipt as completion, so every agent showed done — and idle —
 * the instant it started.
 */

const models = resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'claude-sonnet-5', subagentEffort: 'high' }, DEFAULT_CRITIC)
const TOOL_ID = 'toolu_launch'

let dir: string | null = null

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

function setup(): { runner: LoopRunner; ledger: Ledger; loopId: string; runId: string } {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-async-agent-'))
  const workspaceDir = path.join(dir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  const ledger = new Ledger(path.join(dir, 'ledger.db'))
  const loop = ledger.createLoop({ prompt: 'build it', workspaceDir, maxRounds: 1, budgetUsd: null, models })
  const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })
  return { runner: new LoopRunner(ledger, () => {}), ledger, loopId: loop.id, runId: run.id }
}

function replay(lines: unknown[], runner: LoopRunner, ledger: Ledger, loopId: string, runId: string): void {
  const loop = ledger.getLoop(loopId)!
  const run = ledger.getRun(runId)!
  const parser = (runner as unknown as { makeImplementParser: (l: typeof loop, r: typeof run, g: { suppress: boolean }) => { onLine(line: string): void } }).makeImplementParser(loop, run, { suppress: false })
  for (const line of lines) parser.onLine(JSON.stringify(line))
  // Metrics are persisted on a 15s throttle; jump past it and nudge the parser.
  vi.advanceTimersByTime(20_000)
  parser.onLine(JSON.stringify({ type: 'assistant', message: { id: 'flush', model: 'claude-fable-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } }))
}

function agent(ledger: Ledger, runId: string, id: string) {
  return ledger.getRun(runId)?.metrics?.agents.find((a) => a.id === id)
}

const spawnLines = [
  { type: 'assistant', message: { id: 'm1', model: 'claude-fable-5', content: [{ type: 'tool_use', id: TOOL_ID, name: 'Agent', input: { description: 'Build gameplay slice', model: 'claude-sonnet-5' } }] } },
  { type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: TOOL_ID, description: 'Build gameplay slice', task_type: 'local_agent', is_backgrounded: true },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: TOOL_ID, content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] } },
  // Subagent work streams under parent_tool_use_id while it runs.
  { type: 'assistant', parent_tool_use_id: TOOL_ID, message: { id: 'm2', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'text', text: 'writing files' }] } },
]

describe('backgrounded subagents', () => {
  it('stays running after the launch receipt', () => {
    const { runner, ledger, loopId, runId } = setup()
    replay(spawnLines, runner, ledger, loopId, runId)
    expect(agent(ledger, runId, TOOL_ID)?.done).toBe(false)
  })

  it('finishes on task_notification', () => {
    const { runner, ledger, loopId, runId } = setup()
    replay([...spawnLines, { type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: TOOL_ID, status: 'completed' }], runner, ledger, loopId, runId)
    expect(agent(ledger, runId, TOOL_ID)?.done).toBe(true)
  })

  it('lists an agent that never streamed a message of its own', () => {
    const { runner, ledger, loopId, runId } = setup()
    replay(
      [
        { type: 'system', subtype: 'task_started', task_id: 'a2', tool_use_id: 'toolu_silent', description: 'Port the audio bus', task_type: 'local_agent', is_backgrounded: true },
        { type: 'system', subtype: 'task_notification', task_id: 'a2', tool_use_id: 'toolu_silent', status: 'completed' },
      ],
      runner,
      ledger,
      loopId,
      runId,
    )
    const silent = agent(ledger, runId, 'toolu_silent')
    expect(silent?.label).toBe('Port the audio bus')
    expect(silent?.done).toBe(true)
  })

  // A shell command is a tracked task too. It used to be logged and listed as
  // a subagent — 234 of them against 23 real agents on one real round.
  it('ignores a tracked shell command', () => {
    const { runner, ledger, loopId, runId } = setup()
    replay(
      [
        { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_bash', description: 'Retake final QA screenshots', task_type: 'local_bash', is_backgrounded: false },
        { type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_bash', status: 'completed' },
      ],
      runner,
      ledger,
      loopId,
      runId,
    )
    expect(agent(ledger, runId, 'toolu_bash')).toBeUndefined()
    expect(ledger.eventsForRun(runId).some((line) => line.text.includes('Retake final QA screenshots'))).toBe(false)
  })

  it('still finishes a synchronous agent on its tool_result', () => {
    const { runner, ledger, loopId, runId } = setup()
    replay(
      [
        spawnLines[0],
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: TOOL_ID, content: [{ type: 'text', text: 'done' }] }] } },
        spawnLines[3],
      ],
      runner,
      ledger,
      loopId,
      runId,
    )
    expect(agent(ledger, runId, TOOL_ID)?.done).toBe(true)
  })
})
