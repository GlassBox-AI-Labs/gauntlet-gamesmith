import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isPublisherOtp, PUBLISHER_OTP_LENGTH } from './accounts'

describe('publisher email OTP contract', () => {
  it('accepts the eight-digit email code, preserving leading zeros', () => {
    expect(PUBLISHER_OTP_LENGTH).toBe(8)
    expect(isPublisherOtp('12345678')).toBe(true)
    expect(isPublisherOtp('00123456')).toBe(true)
    for (const value of [
      '123456',
      '1234567',
      '123456789',
      '1234567890',
      '1234abcd',
      '12345678 ',
      12345678,
      null,
    ]) {
      expect(isPublisherOtp(value)).toBe(false)
    }
  })
  it('keeps the local sender length aligned with the app contract', () => {
    const config = readFileSync(
      new URL('../../db/supabase/config.toml', import.meta.url),
      'utf8',
    )
    const emailSection = config.match(
      /^\[auth\.email\]\s*\n([\s\S]*?)(?=^\[)/m,
    )?.[1]
    expect(emailSection).toBeDefined()
    const configuredLength = emailSection?.match(
      /^otp_length\s*=\s*(\d+)\s*$/m,
    )?.[1]
    expect(Number(configuredLength)).toBe(PUBLISHER_OTP_LENGTH)
  })
})
