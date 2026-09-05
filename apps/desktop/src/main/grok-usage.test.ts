import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GrokToolOwnerIndex, grokWorkerTotals, readGrokWorkers } from './grok-usage'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'))
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-ws-'))
const PARENT = '01a06396-70f5-7891-8b01-24d91d9a5555'
const CHILD = '01a06396-9bbc-7160-801d-9da4261d0744'

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(workspace, { recursive: true, force: true })
})

// Grok keys its session directory by the URL-encoded absolute cwd, and realpath
// matters on macOS where /tmp is a symlink into /private/tmp.
const sessions = path.join(home, 'sessions', encodeURIComponent(fs.realpathSync(workspace)))

fs.mkdirSync(path.join(sessions, PARENT, 'subagents', CHILD), { recursive: true })
fs.writeFileSync(
  path.join(sessions, PARENT, 'subagents', CHILD, 'meta.json'),
  JSON.stringify({
    subagent_id: CHILD,
    parent_session_id: PARENT,
    child_session_id: CHILD,
    subagent_type: 'implementer',
    description: 'Build the HUD',
    status: 'completed',
    started_at: '2026-09-02T19:26:49.796767Z',
    completed_at: '2026-09-02T19:27:00.357632Z',
    duration_ms: 10565,
    tool_calls: 2,
    turns: 1,
    effective_model_id: 'grok-4.5',
  }),
)

// The shape grok actually writes, taken from a real run.
fs.mkdirSync(path.join(sessions, CHILD), { recursive: true })
fs.writeFileSync(
  path.join(sessions, CHILD, 'updates.jsonl'),
  [
    JSON.stringify({ method: '_x.ai/session/update', params: { update: { sessionUpdate: 'agent_message_chunk' } } }),
    JSON.stringify({
      method: '_x.ai/session/update',
      params: {
        update: {
          sessionUpdate: 'turn_completed',
          usage: {
            inputTokens: 17558,
            outputTokens: 289,
            totalTokens: 17847,
            cachedReadTokens: 8704,
            cacheCreationTokens: 0,
            costUsdTicks: 237940000,
            numTurns: 2,
          },
        },
      },
    }),
  ].join('\n'),
)

describe('readGrokWorkers', () => {
  it('joins a subagent to its own session record', () => {
    const [worker] = readGrokWorkers(home, workspace, PARENT)
    expect(worker.id).toBe(`worker:${CHILD}`)
    expect(worker.label).toBe('Build the HUD')
    expect(worker.model).toBe('grok-4.5')
    expect(worker.done).toBe(true)
    expect(worker.toolCalls).toBe(2)
    expect(worker.durationMs).toBe(10565)
    expect(worker.messages).toBe(2)
  })

  // Grok stamps microseconds; the ledger's agent contract takes only
  // millisecond ISO and rejects the entire metrics blob otherwise.
  it('rounds grok microsecond timestamps to the millisecond ISO the ledger stores', () => {
    const [worker] = readGrokWorkers(home, workspace, PARENT)
    expect(worker.firstTs).toBe('2026-09-02T19:26:49.796Z')
    for (const ts of [worker.firstTs, worker.lastTs]) {
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
  })

  /**
   * The child's own record counts cached tokens *inside* `inputTokens`, the
   * opposite of the run's result event. Not subtracting them would bill the
   * cached share at full input price.
   */
  it('takes the cached share out of the input count', () => {
    const [worker] = readGrokWorkers(home, workspace, PARENT)
    expect(worker.tokens.input).toBe(17558 - 8704)
    expect(worker.tokens.cacheRead).toBe(8704)
    expect(worker.tokens.output).toBe(289)
  })

  it('prices the worker from the token split at list rates, not Grok ticks', () => {
    const [worker] = readGrokWorkers(home, workspace, PARENT)
    // This fixture's model is grok-4.5: $2 in / $0.30 cached / $6 out per MTok.
    // Ticks on the file ($0.023794) used grok-4.6's $0.50 cache rate and are ignored.
    const priced = ((17558 - 8704) * 2 + 8704 * 0.3 + 289 * 6) / 1_000_000
    expect(worker.costUsd).toBeCloseTo(priced, 6)
  })

  it('returns nothing when the run spawned no subagents', () => {
    expect(readGrokWorkers(home, workspace, 'no-such-session')).toEqual([])
    expect(readGrokWorkers(home, workspace, null)).toEqual([])
    expect(readGrokWorkers(home, '/nowhere', PARENT)).toEqual([])
  })

  it('counts a still-running child from first_token events when no turn has completed', () => {
    const liveParent = '01a06500-4441-7a32-80d0-cde4ac298d51'
    const liveChild = '01a0650c-c206-71d3-9deb-1c1a8dfb4ee4'
    fs.mkdirSync(path.join(sessions, liveParent, 'subagents', liveChild), { recursive: true })
    fs.writeFileSync(
      path.join(sessions, liveParent, 'subagents', liveChild, 'meta.json'),
      JSON.stringify({
        child_session_id: liveChild,
        description: 'COMBAT enemies waves scoring',
        status: 'running',
        effective_model_id: 'grok-4.6',
      }),
    )
    fs.mkdirSync(path.join(sessions, liveChild), { recursive: true })
    fs.writeFileSync(path.join(sessions, liveChild, 'updates.jsonl'), '{}\n')
    fs.writeFileSync(
      path.join(sessions, liveChild, 'events.jsonl'),
      ['{"type":"turn_started"}', '{"type":"first_token"}', '{"type":"tool_completed"}', '{"type":"first_token"}', '{"type":"first_token"}'].join('\n'),
    )
    fs.writeFileSync(
      path.join(sessions, liveChild, 'summary.json'),
      JSON.stringify({ num_chat_messages: 337, last_active_at: '2026-09-03T02:49:46.577728Z' }),
    )
    const [worker] = readGrokWorkers(home, workspace, liveParent)
    expect(worker.label).toBe('COMBAT enemies waves scoring')
    expect(worker.messages).toBe(3)
    expect(worker.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(worker.lastTs).toBe('2026-09-03T02:49:46.577Z')
    expect(worker.done).toBe(false)
  })

  it('totals what the workers spent, which is the share to take off the orchestrator', () => {
    const totals = grokWorkerTotals(readGrokWorkers(home, workspace, PARENT))
    expect(totals.input).toBe(8854)
    expect(totals.cacheRead).toBe(8704)
    expect(totals.output).toBe(289)
  })
})

describe('GrokToolOwnerIndex', () => {
  const TOOL = 'call-25d3b7d7-e571-40d5-9b78-4e1a63cc285f-55'

  it('maps a forwarded tool-call id to the worker whose session recorded it', () => {
    fs.appendFileSync(
      path.join(sessions, CHILD, 'updates.jsonl'),
      `\n${JSON.stringify({
        params: {
          sessionId: CHILD,
          update: { sessionUpdate: 'tool_call', toolCallId: TOOL, title: 'search_replace' },
        },
      })}\n`,
    )
    const index = new GrokToolOwnerIndex(home, workspace)
    index.poll(PARENT)
    expect(index.ownerOf(TOOL)).toEqual({ id: `worker:${CHILD}`, label: 'Build the HUD' })
    expect(index.ownerOf('call-unknown')).toBeNull()
  })
})
