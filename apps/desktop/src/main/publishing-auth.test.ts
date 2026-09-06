import { describe, it, expect } from 'vitest'
import { publisherCredentials } from './publishing-auth'
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
})
