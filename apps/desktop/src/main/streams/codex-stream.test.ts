import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCodexStream, translateCodexLine } from './codex-stream'

describe('translateCodexLine', () => {
  it('keeps every event in the captured Codex 0.147.0 visibility fixture visible', () => {
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-0.147.0-visibility.jsonl'), 'utf8').trim().split('\n')
    const translated = fixture.map((line) => translateCodexLine(line)!)
    expect(translated.every((result) => result.events.length > 0)).toBe(true)
    expect(translated.flatMap((result) => result.events).map((event) => event.kind)).toEqual([
      'system', 'system', 'system', 'system', 'cmd', 'error', 'tool', 'tool', 'error',
    ])
  })

  it('ignores blank lines and surfaces malformed stream data', () => {
    expect(translateCodexLine('')).toBeNull()
    expect(translateCodexLine('warning: not json')?.events).toEqual([
      { channel: 'system', kind: 'system', text: 'unhandled codex non-JSON line: "warning: not json"' },
    ])
    expect(translateCodexLine('null')?.events[0]).toMatchObject({
      channel: 'system',
      kind: 'system',
      text: expect.stringContaining('malformed event'),
    })
  })

  it('extracts the thread id without emitting log events', () => {
    const t = translateCodexLine(JSON.stringify({ type: 'thread.started', thread_id: '01995d1e-0a2b-7e01-b3c4-8b1f2a3d4e5f' }))!
    expect(t.threadStarted).toBe('01995d1e-0a2b-7e01-b3c4-8b1f2a3d4e5f')
    expect(t.events).toEqual([])
  })

  it('rejects a thread id that could traverse a persisted path', () => {
    const t = translateCodexLine(JSON.stringify({ type: 'thread.started', thread_id: '../escape' }))!
    expect(t.threadStarted).toBeNull()
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
    expect(failed.events).toEqual([{ channel: 'error', kind: 'error', text: 'usage limit reached' }])
    expect(translateCodexLine(JSON.stringify({ type: 'turn.failed' }))!.error).toBe('codex turn failed')
  })

  it('keeps only finite nonnegative numbers from hostile usage fixtures', () => {
    const line = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-hostile-usage.jsonl'), 'utf8').trim()
    expect(translateCodexLine(line)?.turn?.usage).toEqual({ output_tokens: 9 })
  })

  it('surfaces failed commands while retaining the command itself', () => {
    const t = translateCodexLine(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'pnpm test', exit_code: 1, status: 'failed', aggregated_output: 'two tests failed' },
      }),
    )!
    expect(t.events).toEqual([
      { channel: 'tool', kind: 'cmd', text: '$ pnpm test' },
      { channel: 'error', kind: 'error', text: 'command failed: two tests failed' },
    ])
  })

  it('keeps the end of a failing command output, where the reason is', () => {
    // The shape that filled a real attempt's log: a playtest harness that streams
    // per-wave telemetry and prints its verdict on the last line.
    const output = `${'wave 1/3 score 0 active 8 '.repeat(40)}{"ok":false,"problems":["Timed out in wave 3"]}`
    const t = translateCodexLine(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'node tools/browser-check.mjs', exit_code: 1, status: 'failed', aggregated_output: output },
      }),
    )!
    const [, failure] = t.events
    // The verdict survives; head truncation would have cut exactly this.
    expect(failure.text.endsWith('{"ok":false,"problems":["Timed out in wave 3"]}')).toBe(true)
    expect(failure.text.startsWith('command failed: …')).toBe(true)
  })

  it('attributes native subagent start and terminal status events to their full thread id', () => {
    const line = (item: Record<string, unknown>): string => JSON.stringify({ type: 'item.completed', item })
    const id = '01995d1e-0a2b-7e01-b3c4-8b1f2a3d4e5f'
    expect(translateCodexLine(line({ type: 'collab_tool_call', agent_id: id, status: 'in_progress' }))?.events).toEqual([
      { agentId: `codex:${id}`, channel: 'tool', kind: 'spawn', text: `⇉ worker "${id}"` },
    ])
    expect(translateCodexLine(line({ type: 'SubAgentActivity', agent_id: id, status: 'completed' }))?.events).toEqual([
      { agentId: `codex:${id}`, channel: 'tool', kind: 'spawn', text: `⇊ worker "${id}" completed` },
    ])
  })

  it('surfaces top-level errors and unfamiliar top-level and item events', () => {
    const error = translateCodexLine(JSON.stringify({ type: 'error', message: 'stream disconnected' }))!
    expect(error.error).toBeUndefined()
    expect(error.streamError).toBe('stream disconnected')
    expect(error.events).toEqual([{ channel: 'error', kind: 'error', text: 'stream disconnected' }])

    expect(translateCodexLine(JSON.stringify({ type: 'item.updated', item: { type: 'todo_list' } }))?.events).toEqual([
      {
        channel: 'system',
        kind: 'system',
        text: 'unhandled codex event "item.updated": {"type":"item.updated","item":{"type":"todo_list"}}',
      },
    ])
    expect(translateCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'future_item', id: 'x' } }))?.events).toEqual([
      {
        channel: 'system',
        kind: 'system',
        text: 'unhandled codex item "future_item": {"type":"future_item","id":"x"}',
      },
    ])
  })
})

describe('Codex stream recovery', () => {
  it('retains an unresolved error until completion and keeps recovery visible', () => {
    const stream = createCodexStream()
    const reconnect = 'Reconnecting... 5/5 (stream disconnected before completion)'
    expect(stream.onLine(JSON.stringify({ type: 'error', message: reconnect }))?.events)
      .toContainEqual({ channel: 'error', kind: 'error', text: reconnect })
    stream.onLine(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Falling back from WebSockets to HTTPS transport.' } }))
    stream.onLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Implemented the game.' } }))
    expect(stream.failure()).toBe(reconnect)
    // Completion without usage is still positive completion evidence.
    const completed = stream.onLine(JSON.stringify({ type: 'turn.completed' }))!
    expect(stream.failure()).toBeNull()
    expect(completed.events).toContainEqual({ channel: 'system', kind: 'system', text: expect.stringContaining('completed after recovering') })
  })

  it('keeps a terminal failure despite a later completion or transport notice', () => {
    const stream = createCodexStream()
    stream.onLine(JSON.stringify({ type: 'turn.failed', error: { message: 'terminal failure' } }))
    stream.onLine(JSON.stringify({ type: 'error', message: 'stream disconnected' }))
    const completed = stream.onLine(JSON.stringify({ type: 'turn.completed' }))!
    expect(stream.failure()).toBe('terminal failure')
    expect(completed.events).toEqual([])
  })

  it('does not use an earlier completion to forgive a later error', () => {
    const stream = createCodexStream()
    stream.onLine(JSON.stringify({ type: 'turn.completed' }))
    stream.onLine(JSON.stringify({ type: 'error', error: { message: 'connection lost' } }))
    stream.onLine(JSON.stringify({ type: 'turn.started' }))
    expect(stream.failure()).toBe('connection lost')
  })
})
