import { describe, expect, it } from 'vitest'
import type { PhaseAttempt } from './build'
import { elapsedThroughAttemptMs, elapsedToAttemptStartMs, runtimeMs } from './attempt-timing'

const origin = '2026-08-31T10:00:00.000Z'

function timing(partial: Partial<PhaseAttempt>): Pick<PhaseAttempt, 'status' | 'startedAt' | 'finishedAt' | 'durationMs'> {
  return {
    status: 'succeeded',
    startedAt: '2026-08-31T10:05:00.000Z',
    finishedAt: '2026-08-31T10:12:00.000Z',
    durationMs: 7 * 60_000,
    ...partial,
  }
}

describe('build timing', () => {
  it('measures when a completed attempt was reached from the build start', () => {
    const attempt = timing({})

    expect(elapsedToAttemptStartMs(origin, attempt)).toBe(5 * 60_000)
    expect(elapsedThroughAttemptMs(origin, attempt)).toBe(12 * 60_000)
  })

  it('uses the current time for a running attempt', () => {
    const attempt = timing({ status: 'running', finishedAt: null, durationMs: null })

    expect(elapsedThroughAttemptMs(origin, attempt, new Date('2026-08-31T10:09:30.000Z').getTime())).toBe(9.5 * 60_000)
  })

  it('leaves an unreached queued attempt blank', () => {
    const attempt = timing({ status: 'queued', startedAt: null, finishedAt: null, durationMs: null })

    expect(elapsedToAttemptStartMs(origin, attempt)).toBeNull()
    expect(elapsedThroughAttemptMs(origin, attempt)).toBeNull()
  })

  it('counts a running attempt up from its start, and blanks a queued one', () => {
    const live = timing({ status: 'running', finishedAt: null, durationMs: null })
    const queued = timing({ status: 'queued', startedAt: null, finishedAt: null, durationMs: null })

    expect(runtimeMs(live, new Date('2026-08-31T10:09:30.000Z').getTime())).toBe(4.5 * 60_000)
    expect(runtimeMs(timing({}))).toBe(7 * 60_000)
    expect(runtimeMs(queued)).toBeNull()
  })

  it('supports older completed records using their duration', () => {
    const attempt = timing({ startedAt: null })

    expect(elapsedToAttemptStartMs(origin, attempt)).toBe(5 * 60_000)
    expect(elapsedThroughAttemptMs(origin, attempt)).toBe(12 * 60_000)
  })
})
