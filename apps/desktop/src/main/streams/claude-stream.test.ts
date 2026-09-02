import { describe, expect, it } from 'vitest'
import { translateClaudeLine } from './claude-stream'

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
  it('ignores blank and non-JSON lines', () => {
    expect(translateClaudeLine('')).toBeNull()
    expect(translateClaudeLine('not json')).toBeNull()
  })

  it('extracts the session and model from init without emitting log events', () => {
    const t = translateClaudeLine(INIT)!
    expect(t.init).toEqual({ sessionId: '07e0f4b1-89ac-4b0f-8f52-0d5caa554591', model: 'claude-fable-5' })
    expect(t.events).toEqual([])
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
    expect(t.events).toEqual([{ channel: 'tool', kind: 'spawn', text: '⇉ spawns "Build the physics slice" (opus)' }])
  })

  it('surfaces tool_result errors and nothing else from user events', () => {
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
      { channel: 'error', kind: 'error', text: '✗ tool error: [{"type":"text","text":"command not found: pnpm"}]' },
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

  it('flags a failed result', () => {
    const t = translateClaudeLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }))!
    expect(t.result).toMatchObject({ text: null, isError: true, subtype: 'error_during_execution' })
  })
})
