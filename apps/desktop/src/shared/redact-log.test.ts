import { describe, expect, it } from 'vitest'
import { redactLogText, redactedErrorMessage } from './redact-log'

describe('redactLogText', () => {
  it('redacts named API and OAuth secrets while keeping the event visible', () => {
    const source = [
      'tool output still visible',
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz',
      '"CLAUDE_CODE_OAUTH_TOKEN":"oauth-value-that-must-not-leak"',
      'https://example.test/callback?access_token=url-secret-value&state=visible',
    ].join('\n')
    const result = redactLogText(source)

    expect(result).toContain('tool output still visible')
    expect(result).toContain('OPENAI_API_KEY=[REDACTED]')
    expect(result).toContain('CLAUDE_CODE_OAUTH_TOKEN":"[REDACTED]')
    expect(result).toContain('access_token=[REDACTED]&state=visible')
    expect(result).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(result).not.toContain('oauth-value-that-must-not-leak')
    expect(result).not.toContain('url-secret-value')
  })

  it('redacts Bearer, JWT, and raw provider-token forms', () => {
    const github = `ghp_${'a'.repeat(36)}`
    const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`
    const result = redactLogText(`Authorization: Bearer bearer-secret-value\n${github}\n${jwt}`)

    expect(result).toContain('Authorization: Bearer [REDACTED]')
    expect(result).not.toContain('bearer-secret-value')
    expect(result).not.toContain(github)
    expect(result).not.toContain(jwt)
    expect(result.match(/\[REDACTED\]/g)?.length).toBe(3)
  })

  it('does not confuse usage counters with authentication tokens', () => {
    const line = 'input tokens 1200 · output tokens 50 · cache tokens 900'
    expect(redactLogText(line)).toBe(line)
  })

  it('redacts complete quoted secrets containing spaces or line breaks', () => {
    const source = '{"password":"two word\nsecret","safe":"visible"}'
    const result = redactLogText(source)
    expect(result).toBe('{"password":"[REDACTED]","safe":"visible"}')
    expect(result).not.toContain('two word')
    expect(result).not.toContain('\nsecret')
  })

  it('redacts cloud secrets, generic token keys, cookies, and URL userinfo', () => {
    const result = redactLogText([
      'AWS_SECRET_ACCESS_KEY=aws-secret-value',
      'AWS_SESSION_TOKEN=session-token-value',
      'DEPLOY_SECRET=deploy-secret-value',
      'PASSWORD=two word secret',
      'AWS_ACCESS_KEY_ID=access-key-value',
      'GOOGLE_APPLICATION_CREDENTIALS=/private/credentials.json',
      'Cookie: session=browser-secret; theme=dark',
      '{"session_cookie":"two word cookie"}',
      'DATABASE_URL=postgres://dbuser:db-password@db.example.test/app',
    ].join('\n'))

    for (const secret of ['aws-secret-value', 'session-token-value', 'deploy-secret-value', 'two word secret', 'access-key-value', '/private/credentials.json', 'browser-secret', 'two word cookie', 'db-password']) {
      expect(result).not.toContain(secret)
    }
    expect(result).toContain('AWS_SECRET_ACCESS_KEY=[REDACTED]')
    expect(result).toContain('PASSWORD=[REDACTED]')
    expect(result).toContain('Cookie: [REDACTED]')
    expect(result).toContain('postgres://dbuser:[REDACTED]@db.example.test/app')
  })

  it('bounds and redacts operational Error messages before IPC projection', () => {
    const secret = `ghp_${'g'.repeat(36)}`
    expect(redactedErrorMessage(new Error(`spawn failed ${secret}`), 'fallback')).toBe('spawn failed [REDACTED]')
    expect(redactedErrorMessage({ message: secret }, 'fallback')).toBe('fallback')
    expect(redactedErrorMessage(new Error('x'.repeat(20)), 'fallback', 8)).toBe('xxxxxxxx')
  })
})
