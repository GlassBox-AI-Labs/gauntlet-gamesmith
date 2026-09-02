import { describe, expect, it } from 'vitest'
import { translateCodexLine } from './codex-stream'

describe('translateCodexLine', () => {
  it('ignores blank and non-JSON lines', () => {
    expect(translateCodexLine('')).toBeNull()
    expect(translateCodexLine('warning: not json')).toBeNull()
  })

  it('extracts the thread id without emitting log events', () => {
    const t = translateCodexLine(JSON.stringify({ type: 'thread.started', thread_id: '01995d1e-0a2b-7e01-b3c4-8b1f2a3d4e5f' }))!
    expect(t.threadStarted).toBe('01995d1e-0a2b-7e01-b3c4-8b1f2a3d4e5f')
    expect(t.events).toEqual([])
  })

  it('maps completed items to channels', () => {
    const line = (item: Record<string, unknown>): string => JSON.stringify({ type: 'item.completed', item })
    expect(translateCodexLine(line({ id: 'item_1', type: 'reasoning', text: '**Scoping the build**\nStart with the renderer.' }))!.events).toEqual([
      { channel: 'thought', kind: 'thought', text: '𝜓 **Scoping the build** Start with the renderer.' },
    ])
    expect(
      translateCodexLine(line({ id: 'item_2', type: 'command_execution', command: "bash -lc 'npm test'", aggregated_output: '', exit_code: 0, status: 'completed' }))!
        .events,
    ).toEqual([{ channel: 'tool', kind: 'cmd', text: "$ bash -lc 'npm test'" }])
    expect(translateCodexLine(line({ id: 'item_3', type: 'web_search', query: 'Celeste dash mechanics frame data' }))!.events).toEqual([
      { channel: 'search', kind: 'search', text: '⌕ Celeste dash mechanics frame data' },
    ])
    expect(translateCodexLine(line({ id: 'item_4', type: 'file_change', changes: [{ path: 'src/game.ts', kind: 'update' }] }))!.events).toEqual([
      { channel: 'tool', kind: 'cmd', text: '✎ [{"path":"src/game.ts","kind":"update"}]' },
    ])
    expect(translateCodexLine(line({ id: 'item_5', type: 'error', message: 'stream disconnected' }))!.events).toEqual([
      { channel: 'error', kind: 'error', text: 'stream disconnected' },
    ])
  })

  it('treats the agent message as output and the summary candidate', () => {
    const t = translateCodexLine(
      JSON.stringify({ type: 'item.completed', item: { id: 'item_6', type: 'agent_message', text: 'All slices landed; running the smoke test.' } }),
    )!
    expect(t.summary).toBe('All slices landed; running the smoke test.')
    expect(t.events).toEqual([{ channel: 'output', kind: 'codex', text: 'All slices landed; running the smoke test.' }])
  })

  it('reports turn completion with usage and turn failure with a message', () => {
    const done = translateCodexLine(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 21_149, cached_input_tokens: 20_480, output_tokens: 382 } }),
    )!
    expect(done.turn).toEqual({ usage: { input_tokens: 21_149, cached_input_tokens: 20_480, output_tokens: 382 } })
    expect(done.events).toEqual([])

    const failed = translateCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } }))!
    expect(failed.error).toBe('usage limit reached')
    expect(translateCodexLine(JSON.stringify({ type: 'turn.failed' }))!.error).toBe('codex turn failed')
  })
})
