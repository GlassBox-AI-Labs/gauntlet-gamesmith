import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { channelForKind } from '../shared/build'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { Ledger } from './ledger'
import { createClaudeImplementProtocol } from './roles/implement-claude'
import { observeChildStreams } from './child-agents'

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

function setup(): { ledger: Ledger; buildId: string; attemptId: string } {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-async-agent-'))
  const workspaceDir = path.join(dir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  const ledger = new Ledger(path.join(dir, 'ledger.db'))
  const build = ledger.createBuild({ prompt: 'build it', workspaceDir, maxRounds: 1, budgetUsd: null, models })
  const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })
  return { ledger, buildId: build.id, attemptId: attempt.id }
}

function replay(lines: unknown[], ledger: Ledger, buildId: string, attemptId: string): void {
  const build = ledger.getBuild(buildId)!
  const attempt = ledger.getAttempt(attemptId)!
  const parser = createClaudeImplementProtocol({
    ledger,
    build,
    attempt,
    gate: { suppress: false },
    childBoundary: observeChildStreams(build.workspaceDir),
    now: Date.now,
    nowIso: () => new Date().toISOString(),
    harnessHome: () => path.join(dir!, 'harness'),
    log: (kind, text, agentId) => ledger.appendEvent({
      buildId,
      attemptId,
      ts: new Date().toISOString(),
      kind,
      channel: channelForKind(kind),
      text,
      ...(agentId ? { agentId } : {}),
    }),
    broadcast: () => {},
    finalize: async () => {},
  })
  for (const line of lines) parser.onLine(JSON.stringify(line))
  // Metrics are persisted on a 15s throttle; jump past it and nudge the parser.
  vi.advanceTimersByTime(20_000)
  parser.onLine(JSON.stringify({ type: 'assistant', message: { id: 'flush', model: 'claude-fable-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } }))
}

function agent(ledger: Ledger, attemptId: string, id: string) {
  return ledger.getAttempt(attemptId)?.metrics?.agents.find((a) => a.id === id)
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
    const { ledger, buildId, attemptId } = setup()
    replay(spawnLines, ledger, buildId, attemptId)
    expect(agent(ledger, attemptId, TOOL_ID)?.done).toBe(false)
  })

  it('finishes on task_notification', () => {
    const { ledger, buildId, attemptId } = setup()
    replay([...spawnLines, { type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: TOOL_ID, status: 'completed' }], ledger, buildId, attemptId)
    expect(agent(ledger, attemptId, TOOL_ID)?.done).toBe(true)
  })

  it('lists an agent that never streamed a message of its own', () => {
    const { ledger, buildId, attemptId } = setup()
    replay(
      [
        { type: 'system', subtype: 'task_started', task_id: 'a2', tool_use_id: 'toolu_silent', description: 'Port the audio bus', task_type: 'local_agent', is_backgrounded: true },
        { type: 'system', subtype: 'task_notification', task_id: 'a2', tool_use_id: 'toolu_silent', status: 'completed' },
      ],
      ledger,
      buildId,
      attemptId,
    )
    const silent = agent(ledger, attemptId, 'toolu_silent')
    expect(silent?.label).toBe('Port the audio bus')
    expect(silent?.done).toBe(true)
  })

  // A shell command is a tracked task too. It must stay out of agent metrics,
  // while VIS-001 still requires its raw lifecycle event in the build log.
  it('does not classify a tracked shell command as a subagent', () => {
    const { ledger, buildId, attemptId } = setup()
    replay(
      [
        { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_bash', description: 'Retake final QA screenshots', task_type: 'local_bash', is_backgrounded: false },
        { type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_bash', status: 'completed' },
      ],
      ledger,
      buildId,
      attemptId,
    )
    expect(agent(ledger, attemptId, 'toolu_bash')).toBeUndefined()
    const shellLifecycle = ledger.eventsForAttempt(attemptId).filter((line) => line.text.includes('Retake final QA screenshots'))
    expect(shellLifecycle.length).toBeGreaterThan(0)
    expect(shellLifecycle.every((line) => line.kind !== 'spawn')).toBe(true)
  })

  it('still finishes a synchronous agent on its tool_result', () => {
    const { ledger, buildId, attemptId } = setup()
    replay(
      [
        spawnLines[0],
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: TOOL_ID, content: [{ type: 'text', text: 'done' }] }] } },
        spawnLines[3],
      ],
      ledger,
      buildId,
      attemptId,
    )
    expect(agent(ledger, attemptId, TOOL_ID)?.done).toBe(true)
  })
})
