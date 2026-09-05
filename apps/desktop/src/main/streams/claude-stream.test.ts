import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StreamEvent } from './claude-stream'
import { normalizeStreamUsage, translateClaudeLine } from './claude-stream'

// Captured from a real `claude -p --output-format stream-json` run.
const INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  cwd: '/tmp/workspace',
  session_id: '07e0f4b1-89ac-4b0f-8f52-0d5caa554591',
  tools: ['Bash', 'Read', 'WebSearch'],
  model: 'claude-fable-5',
  permissionMode: 'bypassPermissions',
})

function assistantLine(content: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_01Xp7aBc',
      type: 'message',
      role: 'assistant',
      model: 'claude-fable-5',
      content,
      usage: { input_tokens: 4, output_tokens: 120, cache_read_input_tokens: 21_000, cache_creation_input_tokens: 900 },
      ...extra,
    },
    parent_tool_use_id: null,
    session_id: '07e0f4b1-89ac-4b0f-8f52-0d5caa554591',
  })
}

describe('translateClaudeLine', () => {
  it('keeps every event in the captured Claude 2.1.251 visibility fixture visible', () => {
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-2.1.251-visibility.jsonl'), 'utf8').trim().split('\n')
    const translated = fixture.map((line) => translateClaudeLine(line)!)
    expect(translated.every((result) => result.events.length > 0)).toBe(true)
    expect(translated.flatMap((result) => result.events).map((event) => event.kind)).toEqual([
      'system', 'system', 'system', 'system', 'tool', 'tool', 'search', 'tool',
      'metric', 'tool', 'tool', 'system', 'tool', 'error', 'tool', 'thought',
    ])
  })

  it('ignores blank lines and surfaces malformed stream data', () => {
    expect(translateClaudeLine('')).toBeNull()
    expect(translateClaudeLine('not json')?.events).toEqual([
      { channel: 'system', kind: 'system', text: 'unhandled claude non-JSON line: "not json"' },
    ])
    expect(translateClaudeLine('null')?.events[0]).toMatchObject({
      channel: 'system',
      kind: 'system',
      text: expect.stringContaining('malformed event'),
    })
  })

  it('extracts the session and model from init without emitting log events', () => {
    const t = translateClaudeLine(INIT)!
    expect(t.init).toEqual({ sessionId: '07e0f4b1-89ac-4b0f-8f52-0d5caa554591', model: 'claude-fable-5' })
    expect(t.events).toEqual([])
  })

  it('rejects an init session id that could traverse a private-home path', () => {
    const t = translateClaudeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: '../escape', model: 'claude-fable-5' }))!
    expect(t.init).toEqual({ sessionId: null, model: 'claude-fable-5' })
  })

  it('maps assistant text, thinking, and tool calls to channels', () => {
    const t = translateClaudeLine(
      assistantLine([
        { type: 'thinking', thinking: 'The pack gate needs eight stills before round 1 can start.', signature: 'sig' },
        { type: 'text', text: 'Downloading reference stills now.' },
        { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls reference/' } },
        { type: 'tool_use', id: 'toolu_02', name: 'WebSearch', input: { query: 'Hades II boss arena screenshots' } },
        { type: 'tool_use', id: 'toolu_03', name: 'Read', input: { file_path: '/tmp/workspace/reference/README.md' } },
      ]),
    )!
    expect(t.events).toEqual([
      { channel: 'thought', kind: 'thought', text: '𝜓 The pack gate needs eight stills before round 1 can start.' },
      { channel: 'output', kind: 'claude', text: 'Downloading reference stills now.' },
      { channel: 'tool', kind: 'cmd', text: '$ ls reference/' },
      { channel: 'search', kind: 'search', text: '⌕ Hades II boss arena screenshots' },
      { channel: 'tool', kind: 'tool', text: '→ Read {"file_path":"/tmp/workspace/reference/README.md"}' },
    ])
    expect(t.summary).toBe('Downloading reference stills now.')
    expect(t.usage).toEqual({
      messageId: 'msg_01Xp7aBc',
      model: 'claude-fable-5',
      usage: { input_tokens: 4, output_tokens: 120, cache_read_input_tokens: 21_000, cache_creation_input_tokens: 900 },
    })
  })

  it('narrates Agent and Task tool calls as spawns', () => {
    const t = translateClaudeLine(
      assistantLine([{ type: 'tool_use', id: 'toolu_09', name: 'Agent', input: { description: 'Build the physics slice', model: 'opus', prompt: '…' } }]),
    )!
    expect(t.events).toEqual([{ agentId: 'toolu_09', channel: 'tool', kind: 'spawn', text: '⇉ spawns "Build the physics slice" (opus)' }])
  })

  it('keeps malformed spawn metadata visible without trusting its id or scalar fields', () => {
    const t = translateClaudeLine(
      assistantLine([{ type: 'tool_use', id: '../escape', name: 'Agent', input: { description: 42, model: false } }]),
    )!
    expect(t.events).toEqual([{ channel: 'tool', kind: 'spawn', text: '⇉ spawns "subagent"' }])
  })

  it('surfaces successful and failed tool results from user events', () => {
    const t = translateClaudeLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'toolu_02', is_error: true, content: [{ type: 'text', text: 'command not found: pnpm' }] },
          ],
        },
      }),
    )!
    expect(t.events).toEqual([
      { channel: 'tool', kind: 'tool', text: '← tool result: "ok"' },
      { channel: 'error', kind: 'error', text: '✗ tool error: [{"type":"text","text":"command not found: pnpm"}]' },
    ])
  })

  it('reads the usage heartbeat in both the current and legacy shapes', () => {
    const current = translateClaudeLine(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: 0.76, resetsAt: 1788573600 },
          seven_day: { utilization: 0.06, resetsAt: 1789095600 },
        },
      },
    }))
    expect(current?.events).toEqual([{
      channel: 'system',
      kind: 'system',
      text: 'Claude usage: five_hour 76% · seven_day 6%; five_hour resets 2026-09-05T02:00:00.000Z',
    }])

    // A blocked heartbeat leads with the status the CLI reported.
    const blocked = translateClaudeLine(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'blocked', unifiedWindows: { five_hour: { utilization: 1 } } },
    }))
    expect(blocked?.events[0].text).toBe('Claude usage [blocked]: five_hour 100%')

    expect(translateClaudeLine(JSON.stringify({ type: 'rate_limit_event', reset_at: '2026-09-05T04:00:00.000Z' }))?.events).toEqual([
      { channel: 'system', kind: 'system', text: 'Claude rate limit; reset at: 2026-09-05T04:00:00.000Z' },
    ])
  })

  it('reads background-task and heartbeat events as agent progress, not unknown noise', () => {
    const line = (event: Record<string, unknown>): StreamEvent => translateClaudeLine(JSON.stringify(event))!.events[0]

    // A thinking-token estimate is a counter, so it files with the other token counters.
    expect(line({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 2_000, estimated_tokens_delta: 100 }))
      .toEqual({ channel: 'usage', kind: 'metric', text: '𝜓 thinking ≈2000 tokens' })

    // Task events carry the spawning tool-use id, so they land under that agent.
    expect(line({ type: 'system', subtype: 'task_started', task_type: 'local_bash', tool_use_id: 'toolu_a', description: 'Install deps' }))
      .toEqual({ agentId: 'toolu_a', channel: 'tool', kind: 'tool', text: '▶ local_bash started "Install deps"' })
    expect(line({
      type: 'system',
      subtype: 'task_progress',
      tool_use_id: 'toolu_a',
      description: 'Physics slice',
      usage: { total_tokens: 15_161, tool_uses: 1, duration_ms: 3_037 },
      last_tool_name: 'Bash',
    })).toEqual({ agentId: 'toolu_a', channel: 'tool', kind: 'tool', text: '⋯ Physics slice (15161 tokens · 1 tools · 3s · Bash)' })

    // A failed background task is an error, not a system aside.
    expect(line({ type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_a', status: 'failed', summary: 'build broke' }))
      .toEqual({ agentId: 'toolu_a', channel: 'error', kind: 'error', text: '✗ task failed: build broke' })
    expect(line({ type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_a', status: 'completed', summary: 'done' }))
      .toEqual({ agentId: 'toolu_a', channel: 'tool', kind: 'tool', text: '✓ task completed: done' })

    expect(line({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ description: 'Feel pass' }, { description: 'Audio pass' }] }))
      .toEqual({ channel: 'system', kind: 'system', text: 'background tasks: Feel pass · Audio pass' })
    expect(line({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }))
      .toEqual({ channel: 'system', kind: 'system', text: 'background tasks: none' })

    // A tool heartbeat is attributed to the agent running the tool.
    expect(line({ type: 'tool_progress', tool_name: 'Bash', parent_tool_use_id: 'toolu_a', elapsed_time_seconds: 30, heartbeat: true }))
      .toEqual({ agentId: 'toolu_a', channel: 'tool', kind: 'tool', text: '⋯ Bash still running (30s)' })

    // Interleaved thinking sends signature-only blocks; the turn still shows.
    expect(translateClaudeLine(assistantLine([{ type: 'thinking', thinking: '', signature: 'sig' }]))?.events)
      .toEqual([{ channel: 'thought', kind: 'thought', text: '𝜓 (thinking withheld)' }])
  })

  it('surfaces unfamiliar top-level events and assistant blocks with their raw kind', () => {
    expect(translateClaudeLine(JSON.stringify({ type: 'rate_limit_event', reset_at: 'soon' }))?.events).toEqual([
      {
        channel: 'system',
        kind: 'system',
        text: 'unhandled claude event "rate_limit_event": {"type":"rate_limit_event","reset_at":"soon"}',
      },
    ])
    expect(translateClaudeLine(assistantLine([{ type: 'future_content', value: 42 }]))?.events).toEqual([
      {
        channel: 'system',
        kind: 'system',
        text: 'unhandled claude content block "future_content": {"type":"future_content","value":42}',
      },
    ])
  })

  it('preserves a structured provider reset time for the rate-limit scheduler', () => {
    expect(translateClaudeLine(JSON.stringify({ type: 'rate_limit_event', reset_at: '2026-09-02T12:30:00.000Z' }))?.events).toEqual([
      { channel: 'system', kind: 'system', text: 'Claude rate limit; reset at: 2026-09-02T12:30:00.000Z' },
    ])
  })

  it('keeps nested Claude events attributed to the spawning tool-use id', () => {
    const t = translateClaudeLine(
      assistantLine([{ type: 'text', text: 'Physics slice complete.' }], { parent_tool_use_id: 'ignored-message-field' })
        .replace('"parent_tool_use_id":null', '"parent_tool_use_id":"toolu_agent_7"'),
    )!
    expect(t.events).toEqual([
      { agentId: 'toolu_agent_7', channel: 'output', kind: 'claude', text: 'Physics slice complete.' },
    ])
  })

  it('captures the result event with its authoritative usage', () => {
    const t = translateClaudeLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 5_400_000,
        num_turns: 42,
        result: 'Round 1 build complete.',
        total_cost_usd: 12.34,
        usage: { input_tokens: 50, output_tokens: 9_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 12_000 },
      }),
    )!
    expect(t.events).toEqual([])
    expect(t.result).toMatchObject({
      text: 'Round 1 build complete.',
      isError: false,
      subtype: 'success',
      usage: { input_tokens: 50, output_tokens: 9_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 12_000 },
    })
  })

  it('keeps only finite nonnegative numbers from hostile usage fixtures', () => {
    const line = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-hostile-usage.jsonl'), 'utf8').trim()
    expect(translateClaudeLine(line)?.usage?.usage).toEqual({ output_tokens: 7 })
  })

  it('allowlists snake_case and aggregate camelCase counters without copying hostile keys', () => {
    expect(
      normalizeStreamUsage({
        input_tokens: 1,
        inputTokens: 2,
        attackerControlled: 3,
        ['x'.repeat(10_000)]: 4,
      }),
    ).toEqual({ input_tokens: 1, inputTokens: 2 })
  })

  it('flags a failed result', () => {
    const t = translateClaudeLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }))!
    expect(t.result).toMatchObject({ text: null, isError: true, subtype: 'error_during_execution' })
    expect(t.events).toEqual([
      { channel: 'error', kind: 'error', text: 'claude result error_during_execution' },
    ])
  })
})

describe('grok, which emits the same wire format', () => {
  it('reads per-message usage off a grok assistant event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'grok-4.6',
        content: [{ type: 'text', text: 'DONE' }],
        usage: { input_tokens: 129, output_tokens: 47, cache_read_input_tokens: 17408, cache_creation_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    })
    const t = translateClaudeLine(line)!
    expect(t.usage?.model).toBe('grok-4.6')
    expect(t.usage?.usage.cache_read_input_tokens).toBe(17408)
    expect(t.summary).toBe('DONE')
  })

  it('recognises grok tool names as the same events claude produces', () => {
    const spawn = translateClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'spawn_subagent', id: 'c1', input: { description: 'Build the HUD', subagent_type: 'general-purpose' } }] },
      }),
    )!
    expect(spawn.events[0].kind).toBe('spawn')
    expect(spawn.events[0].text).toContain('Build the HUD')

    const cmd = translateClaudeLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'run_terminal_command', input: { command: 'pnpm build' } }] } }),
    )!
    expect(cmd.events[0].kind).toBe('cmd')
    expect(cmd.events[0].text).toContain('pnpm build')
  })

  /** Grok names the failure in an `errors` array; claude has no such field. */
  it('carries the errors array off a failed result', () => {
    const t = translateClaudeLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        total_cost_usd: 0,
        errors: ["Couldn't set model 'grok-build': unknown model id"],
      }),
    )!
    expect(t.result?.isError).toBe(true)
    expect(t.result?.subtype).toBe('error_during_execution')
    expect(t.result?.errors?.[0]).toContain('unknown model id')
  })

  it('reads the cost and totals off a grok success result', () => {
    const t = translateClaudeLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'DONE',
        total_cost_usd: 0.053092,
        usage: { input_tokens: 17446, output_tokens: 132, cache_read_input_tokens: 34816 },
      }),
    )!
    expect(t.result?.text).toBe('DONE')
    expect(t.result?.usage?.input_tokens).toBe(17446)
    expect(t.result?.raw.total_cost_usd).toBe(0.053092)
  })
})
