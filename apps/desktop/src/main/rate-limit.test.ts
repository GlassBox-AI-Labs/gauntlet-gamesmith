import { describe, expect, it } from 'vitest'
import { isRateLimitError, MAX_RATE_LIMIT_PAUSES, rateLimitPause, retryAtFromError } from './rate-limit'

describe('rate limit policy', () => {
  it('distinguishes throttling from ordinary failures', () => {
    expect(isRateLimitError('compile failed')).toBe(false)
    expect(isRateLimitError('The critic says rate-limit handling needs a regression test.')).toBe(false)
    expect(isRateLimitError('Build failed after rendering the words “usage limit” in the settings screen.')).toBe(false)
    expect(isRateLimitError('HTTP 429 too many requests')).toBe(true)
    expect(rateLimitPause('compile failed', 0, 1_000)).toBeNull()
    expect(rateLimitPause('HTTP 429 too many requests', 0, 1_000)).toEqual({ delayMs: 30_000, retryAtMs: 31_000 })
  })

  it('publishes a finite durable retry budget', () => {
    expect(MAX_RATE_LIMIT_PAUSES).toBe(8)
  })

  it('honors reset hints while bounding exponential backoff', () => {
    expect(rateLimitPause('rate limit; retry after 90 seconds', 0, 1_000)?.delayMs).toBe(90_000)
    expect(rateLimitPause('usage limit exceeded', 20, 1_000)?.delayMs).toBe(15 * 60_000)
    expect(rateLimitPause('Claude rate limit; reset at: 2026-09-02T12:30:00.000Z', 0, Date.parse('2026-09-02T12:29:00.000Z'))?.delayMs).toBe(60_000)
  })

  it('recovers a durable retry time from the interrupted run error', () => {
    expect(retryAtFromError('Rate limited; retry scheduled for 2026-09-02T12:30:00.000Z.')).toBe(Date.parse('2026-09-02T12:30:00.000Z'))
    expect(retryAtFromError('ordinary error')).toBeNull()
  })
})
