import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
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
