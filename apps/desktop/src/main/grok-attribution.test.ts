import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// cliHome('grok') resolves off the app's user-data path.
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { observeChildStreams, type ChildStreamBoundary } from './child-agents'
import { Ledger } from './ledger'
import { LoopRunner } from './loop-runner'

/**
 * Grok forwards a subagent's messages into the parent stream, so the worker's
 * tokens are already inside the run totals. Worker rows therefore have to
 * *split* that total apart. Adding them on top — the right move for codex and
 * for cross-harness children — would double every delegated grok run's cost.
 */

const models = resolveModels({ orchestratorModel: 'grok-4.6', subagentModel: 'grok-4.5', subagentEffort: 'low' }, DEFAULT_CRITIC)
const SESSION = '01a06396-70f5-7891-8b01-24d91d9a5555'
const CHILD = '01a06396-9bbc-7160-801d-9da4261d0744'

let dir: string | null = null

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

function seedGrokSession(workspaceDir: string): void {
  const sessions = path.join(os.tmpdir(), 'harnesses', 'grok', 'sessions', encodeURIComponent(fs.realpathSync(workspaceDir)))
  fs.mkdirSync(path.join(sessions, SESSION, 'subagents', CHILD), { recursive: true })
  fs.writeFileSync(
    path.join(sessions, SESSION, 'subagents', CHILD, 'meta.json'),
    JSON.stringify({ child_session_id: CHILD, subagent_type: 'implementer', description: 'HUD slice', status: 'completed', tool_calls: 2, effective_model_id: 'grok-4.5' }),
  )
  fs.mkdirSync(path.join(sessions, CHILD), { recursive: true })
  fs.writeFileSync(
    path.join(sessions, CHILD, 'updates.jsonl'),
    JSON.stringify({
      params: { update: { sessionUpdate: 'turn_completed', usage: { inputTokens: 300, outputTokens: 40, cachedReadTokens: 100, cacheCreationTokens: 0, costUsdTicks: 10_000_000, numTurns: 1 } } },
    }),
  )
}

describe('grok worker attribution', () => {
  it('splits the run total instead of adding to it', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-grok-'))
    const workspaceDir = path.join(dir, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    seedGrokSession(workspaceDir)

    const ledger = new Ledger(path.join(dir, 'ledger.db'))
    const loop = ledger.createLoop({ prompt: 'build it', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'grok', prompt: 'go' })
    const runner = new LoopRunner(ledger, () => {}, async () => ({ ok: false, from: 'test' }))
    const parser = (
      runner as unknown as {
        makeImplementParser: (
          l: typeof loop,
          r: typeof run,
          g: { suppress: boolean },
          b: ChildStreamBoundary,
        ) => { onLine(line: string): void }
      }
    ).makeImplementParser(loop, run, { suppress: false }, observeChildStreams(workspaceDir))

    // The stream carries the orchestrator's own turn plus the worker's,
    // both unattributed — parent_tool_use_id is null on every grok event.
    const lines = [
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'grok-4.6' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: 'm1', model: 'grok-4.6', usage: { input_tokens: 500, output_tokens: 60, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', id: 't1', name: 'spawn_subagent', input: { description: 'HUD slice', subagent_type: 'implementer' } }] },
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: 'm2', model: 'grok-4.6', usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }, content: [] },
      },
    ]
    for (const line of lines) parser.onLine(JSON.stringify(line))
    vi.advanceTimersByTime(20_000)
    parser.onLine(JSON.stringify({ type: 'assistant', message: { id: 'flush', model: 'grok-4.6', usage: { input_tokens: 0, output_tokens: 0 }, content: [] } }))

    const agents = ledger.getRun(run.id)?.metrics?.agents ?? []
    const orchestrator = agents.find((a) => a.id === 'orchestrator')!
    const worker = agents.find((a) => a.id === `worker:${CHILD}`)!

    expect(worker.label).toBe('HUD slice')
    expect(worker.model).toBe('grok-4.5')
    // The child's own record counts cache inside inputTokens; 300 − 100 = 200.
    expect(worker.tokens.input).toBe(200)

    // Stream totals were 700 input and 300 cache read. The worker's share comes
    // off the orchestrator, so the two rows still sum to what the run spent.
    expect(orchestrator.tokens.input).toBe(700 - 200)
    expect(orchestrator.tokens.cacheRead).toBe(300 - 100)
    expect(orchestrator.tokens.input + worker.tokens.input).toBe(700)
  })

  it('lists each worker once, not once from the spawn call and again from disk', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-grok-dup-'))
    const workspaceDir = path.join(dir, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    seedGrokSession(workspaceDir)

    const ledger = new Ledger(path.join(dir, 'ledger.db'))
    const loop = ledger.createLoop({ prompt: 'build it', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'grok', prompt: 'go' })
    const runner = new LoopRunner(ledger, () => {}, async () => ({ ok: false, from: 'test' }))
    const parser = (
      runner as unknown as {
        makeImplementParser: (
          l: typeof loop,
          r: typeof run,
          g: { suppress: boolean },
          b: ChildStreamBoundary,
        ) => { onLine(line: string): void }
      }
    ).makeImplementParser(loop, run, { suppress: false }, observeChildStreams(workspaceDir))

    parser.onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION, model: 'grok-4.6' }))
    parser.onLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', model: 'grok-4.6', usage: { input_tokens: 500, output_tokens: 60 }, content: [{ type: 'tool_use', id: 't1', name: 'spawn_subagent', input: { description: 'HUD slice' } }] },
      }),
    )
    vi.advanceTimersByTime(20_000)
    parser.onLine(JSON.stringify({ type: 'assistant', message: { id: 'flush', model: 'grok-4.6', usage: { input_tokens: 0, output_tokens: 0 }, content: [] } }))

    const agents = ledger.getRun(run.id)?.metrics?.agents ?? []
    expect(agents.filter((a) => a.id !== 'orchestrator')).toHaveLength(1)
    expect(agents.find((a) => a.id === 't1')).toBeUndefined()
  })

  it('stamps forwarded grok tool calls with the worker that issued them, not orchestrator', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-grok-log-'))
    const workspaceDir = path.join(dir, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    seedGrokSession(workspaceDir)
    const toolId = 'call-25d3b7d7-e571-40d5-9b78-4e1a63cc285f-55'
    const sessions = path.join(os.tmpdir(), 'harnesses', 'grok', 'sessions', encodeURIComponent(fs.realpathSync(workspaceDir)))
    fs.appendFileSync(
      path.join(sessions, CHILD, 'updates.jsonl'),
      `\n${JSON.stringify({
        params: { sessionId: CHILD, update: { sessionUpdate: 'tool_call', toolCallId: toolId, title: 'search_replace' } },
      })}\n`,
    )

    const ledger = new Ledger(path.join(dir, 'ledger.db'))
    const loop = ledger.createLoop({ prompt: 'build it', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'grok', prompt: 'go' })
    const sent: { text: string; agentId?: string }[] = []
    const runner = new LoopRunner(
      ledger,
      (channel, payload) => {
        if (channel === 'loop:log') sent.push(payload as { text: string; agentId?: string })
      },
      async () => ({ ok: false, from: 'test' }),
    )
    const parser = (
      runner as unknown as {
        makeImplementParser: (
          l: typeof loop,
          r: typeof run,
          g: { suppress: boolean },
          b: ChildStreamBoundary,
        ) => { onLine(line: string): void }
      }
    ).makeImplementParser(loop, run, { suppress: false }, observeChildStreams(workspaceDir))

    parser.onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION, model: 'grok-4.6' }))
    parser.onLine(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'm2',
          model: 'grok-4.6',
          content: [
            {
              type: 'tool_use',
              id: toolId,
              name: 'search_replace',
              input: { file_path: `${workspaceDir}/src/render/projectile-view.ts` },
            },
          ],
        },
      }),
    )

    const line = sent.find((item) => item.text.includes('search_replace'))
    expect(line?.text).toContain('[HUD slice]')
    expect(line?.text).not.toContain('[orchestrator]')
    expect(line?.agentId).toBe(`worker:${CHILD}`)
  })
})
