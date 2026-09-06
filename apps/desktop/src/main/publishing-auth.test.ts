import { describe, it, expect } from 'vitest'
import {
  enrollmentEmail,
  publisherCredentials,
  publisherSignup,
  publisherVerification,
} from './publishing-auth'
describe('publisher credential IPC validation', () => {
  it('preserves password whitespace and strips unexpected fields', () => {
    expect(
      publisherCredentials({
        email: ' developer@example.com ',
        password: ' secret ',
        extra: 'ignored',
      }),
    ).toEqual({ email: 'developer@example.com', password: ' secret ' })
  })
  it('rejects untrusted inputs without echoing credentials', () => {
    for (const value of [
      null,
      [],
      { email: 42, password: 'private-password' },
      { email: 'developer@example.com', password: '' },
      {
        email: 'developer@example.com',
        password: 'private-password'.repeat(100),
      },
    ]) {
      expect(() => publisherCredentials(value)).toThrow()
      try {
        publisherCredentials(value)
      } catch (error) {
        expect(String(error)).not.toContain('private-password')
      }
    }
  })
  it('accepts only the exact Challenger domain for self-service enrollment', () => {
    expect(
      enrollmentEmail({ email: ' Person@CHALLENGER.GAUNTLETAI.COM ' }),
    ).toEqual({ email: 'person@challenger.gauntletai.com' })
    for (const email of [
      'a@gauntletai.com',
      'a@sub.challenger.gauntletai.com',
      'a@challenger.gauntletai.com.evil.test',
      'a@@challenger.gauntletai.com',
    ])
      expect(() => enrollmentEmail({ email })).toThrow(
        'Use your @challenger.gauntletai.com',
      )
  })
  it('validates signup and verification without changing the password or reflecting codes', () => {
    const email = 'person@challenger.gauntletai.com'
    expect(
      publisherSignup({
        email,
        password: ' long password ',
        displayName: ' Person ',
      }),
    ).toEqual({ email, password: ' long password ', displayName: 'Person' })
    expect(() =>
      publisherSignup({ email, password: 'short', displayName: 'Person' }),
    ).toThrow('at least 10')
    expect(publisherVerification({ email, code: '123456' })).toEqual({
      email,
      code: '123456',
    })
    expect(() => publisherVerification({ email, code: 'secret-code' })).toThrow(
      'Enter the verification code',
    )
  })
})
