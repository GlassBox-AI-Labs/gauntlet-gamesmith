import { describe, expect, it } from 'vitest'
import type { RunRecord } from './loop'
import { elapsedThroughRunMs, elapsedToRunStartMs } from './run-timing'

const origin = '2026-08-31T10:00:00.000Z'

function timing(partial: Partial<RunRecord>): Pick<RunRecord, 'status' | 'startedAt' | 'finishedAt' | 'durationMs'> {
  return {
    status: 'succeeded',
    startedAt: '2026-08-31T10:05:00.000Z',
    finishedAt: '2026-08-31T10:12:00.000Z',
    durationMs: 7 * 60_000,
    ...partial,
  }
}

describe('run timing', () => {
  it('measures when a completed attempt was reached from the loop start', () => {
    const run = timing({})

    expect(elapsedToRunStartMs(origin, run)).toBe(5 * 60_000)
    expect(elapsedThroughRunMs(origin, run)).toBe(12 * 60_000)
  })

  it('uses the current time for a running attempt', () => {
    const run = timing({ status: 'running', finishedAt: null, durationMs: null })

    expect(elapsedThroughRunMs(origin, run, new Date('2026-08-31T10:09:30.000Z').getTime())).toBe(9.5 * 60_000)
  })

  it('leaves an unreached queued attempt blank', () => {
    const run = timing({ status: 'queued', startedAt: null, finishedAt: null, durationMs: null })

    expect(elapsedToRunStartMs(origin, run)).toBeNull()
    expect(elapsedThroughRunMs(origin, run)).toBeNull()
  })

  it('supports older completed records using their duration', () => {
    const run = timing({ startedAt: null })

    expect(elapsedToRunStartMs(origin, run)).toBe(5 * 60_000)
    expect(elapsedThroughRunMs(origin, run)).toBe(12 * 60_000)
  })
})
