import { describe, expect, it, vi } from 'vitest'
import { createArtifactPhaseStream } from './artifact-phase-stream'

describe('createArtifactPhaseStream', () => {
  it.each(['reference', 'critique'] as const)('clears recovered Codex errors and rate pauses during %s', phase => {
    const log = vi.fn()
    const stream = createArtifactPhaseStream({
      harness: 'codex', phase, defaultModel: 'gpt-5.6-sol', startedAtMs: 10,
      now: () => 20, log, onIdentity: () => {}, onUsage: () => {},
    })
    const message = 'usage limit reached; retry after 30 seconds'
    stream.onLine(JSON.stringify({ type: 'error', message }))
    expect(stream.snapshot()).toMatchObject({ failure: message, rateLimitNotice: message })
    stream.onLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }))
    expect(stream.snapshot()).toMatchObject({ failure: null, rateLimitNotice: null, tokens: { input: 5, output: 2 } })
    expect(log.mock.calls.some(([kind, text]) => kind === 'error' && text.includes(message))).toBe(true)
    expect(log.mock.calls.some(([kind, text]) => kind === 'system' && text.includes('completed after recovering'))).toBe(true)
  })

  it('deduplicates Claude message usage and exposes one harness-neutral snapshot', () => {
    const log = vi.fn()
    const onIdentity = vi.fn()
    const onUsage = vi.fn()
    let now = 100
    const stream = createArtifactPhaseStream({
      harness: 'claude',
      phase: 'reference',
      defaultModel: 'claude-fable-5',
      startedAtMs: 10,
      initialSessionId: null,
      now: () => ++now,
      log,
      onIdentity,
      onUsage,
    })
    stream.onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-one', model: 'claude-fable-5' }))
    for (const output_tokens of [5, 7]) {
      stream.onLine(
        JSON.stringify({
          type: 'assistant',
          message: { id: 'same-message', model: 'claude-fable-5', usage: { input_tokens: 2, output_tokens }, content: [] },
        }),
      )
    }

    expect(stream.snapshot()).toMatchObject({
      tokens: { input: 2, output: 7, cacheRead: 0, cacheWrite: 0 },
      messages: 1,
      sawUsage: true,
      sessionId: 'session-one',
      reportedModel: 'claude-fable-5',
    })
    expect(onIdentity).toHaveBeenCalledWith('session-one', 'claude-fable-5')
    expect(onUsage).toHaveBeenCalledTimes(2)
  })

  it('tracks Codex identity, totals, rate limiting, errors, and visible event attribution', () => {
    const events: Array<{ kind: string; text: string; agentId?: string }> = []
    const stream = createArtifactPhaseStream({
      harness: 'codex',
      phase: 'critique',
      defaultModel: 'gpt-5.6-sol',
      startedAtMs: 10,
      now: () => 20,
      log: (kind, text, agentId) => events.push({ kind, text, agentId }),
      onIdentity: () => {},
      onUsage: () => {},
    })
    stream.onLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-one' }))
    stream.onLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 21, cached_input_tokens: 12, output_tokens: 13 } }))
    stream.onLine(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached; retry after 30 seconds' } }))

    expect(stream.snapshot()).toMatchObject({
      tokens: { input: 9, output: 13, cacheRead: 12, cacheWrite: 0 },
      messages: 1,
      failure: 'usage limit reached; retry after 30 seconds',
      rateLimitNotice: 'usage limit reached; retry after 30 seconds',
      sessionId: 'thread-one',
    })
    expect(events).toContainEqual({ kind: 'error', text: 'usage limit reached; retry after 30 seconds', agentId: undefined })
  })

  it('does not let incidental rate-limit prose override the actual terminal failure', () => {
    const stream = createArtifactPhaseStream({
      harness: 'codex',
      phase: 'reference',
      defaultModel: 'gpt-5.6-sol',
      startedAtMs: 10,
      now: () => 20,
      log: () => {},
      onIdentity: () => {},
      onUsage: () => {},
    })
    stream.onLine(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'I added a rate-limit handling screen to the game.' },
    }))
    stream.onLine(JSON.stringify({ type: 'turn.failed', error: { message: 'TypeError: renderer crashed' } }))

    expect(stream.snapshot()).toMatchObject({
      summary: 'I added a rate-limit handling screen to the game.',
      failure: 'TypeError: renderer crashed',
      rateLimitNotice: null,
    })
  })

  it('clears a reconnect the stream recovered from once the turn completes', () => {
    const stream = createArtifactPhaseStream({
      harness: 'codex',
      phase: 'reference',
      defaultModel: 'gpt-6-astra',
      startedAtMs: 10,
      now: () => 20,
      log: () => {},
      onIdentity: () => {},
      onUsage: () => {},
    })
    // The real shape: codex burns all five reconnects, falls back to HTTPS, and
    // works on for another half hour before finishing normally.
    for (const attempt of [2, 3, 4, 5]) {
      stream.onLine(JSON.stringify({
        type: 'error',
        message: `Reconnecting... ${attempt}/5 (stream disconnected before completion: websocket closed by server before response.completed)`,
      }))
    }
    expect(stream.snapshot().failure).toMatch(/Reconnecting/)

    stream.onLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Reference Pack complete.' } }))
    stream.onLine(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 242906, cached_input_tokens: 209024, cache_write_input_tokens: 0, output_tokens: 1459 },
    }))

    expect(stream.snapshot()).toMatchObject({ failure: null, summary: 'Reference Pack complete.' })
  })

  it('still reports a failure that arrives after the turn completed', () => {
    const stream = createArtifactPhaseStream({
      harness: 'codex',
      phase: 'reference',
      defaultModel: 'gpt-6-astra',
      startedAtMs: 10,
      now: () => 20,
      log: () => {},
      onIdentity: () => {},
      onUsage: () => {},
    })
    stream.onLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } }))
    stream.onLine(JSON.stringify({ type: 'turn.failed', error: { message: 'TypeError: renderer crashed' } }))
    expect(stream.snapshot().failure).toBe('TypeError: renderer crashed')
  })

  it('bounds lifetime Claude usage identities and reports omitted live accounting once', () => {
    const log = vi.fn()
    const stream = createArtifactPhaseStream({
      harness: 'claude',
      phase: 'critique',
      defaultModel: 'claude-fable-5',
      startedAtMs: 10,
      now: () => 20,
      log,
      onIdentity: () => {},
      onUsage: () => {},
    })
    for (let index = 0; index < 2_050; index += 1) {
      stream.onLine(JSON.stringify({
        type: 'assistant',
        message: { id: `message-${index}`, usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
      }))
    }

    expect(stream.snapshot()).toMatchObject({ messages: 2_048, tokens: { input: 2_048, output: 2_048 } })
    expect(log.mock.calls.filter(([, text]) => String(text).includes('projection limit'))).toHaveLength(1)
  })
})
