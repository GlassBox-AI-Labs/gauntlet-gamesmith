import { describe, expect, it } from 'vitest'
import {
  parseClaudeStatus,
  parseCodexStatus,
  parseUrls,
  stripAnsi,
  subscriptionAuthError,
} from './harness-status'

describe('harness status parsing', () => {
  it('strips terminal controls and extracts login links', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m\r')).toBe('red')
    expect(parseUrls('Open https://example.test/login?code=1.')).toEqual(['https://example.test/login?code=1.'])
  })

  it('validates Claude JSON rather than trusting a cast', () => {
    expect(parseClaudeStatus('{"loggedIn":true,"authMethod":"oauth","apiProvider":"firstParty"}', '', '1.2.3')).toMatchObject({
      loggedIn: true,
      billingMode: 'subscription',
      authMethod: 'oauth',
      details: expect.arrayContaining([['Provider', 'Anthropic API']]),
    })
    expect(parseClaudeStatus('{"loggedIn":"yes"}', '', '1.2.3')).toEqual({ loggedIn: false, error: '{"loggedIn":"yes"}' })
    expect(parseClaudeStatus('null', '', null)).toEqual({ loggedIn: false, error: 'null' })
  })

  it('recognizes only a successful Codex login status', () => {
    expect(parseCodexStatus(true, 'Logged in using ChatGPT', '', '2.0')).toMatchObject({
      loggedIn: true,
      billingMode: 'subscription',
      authMethod: 'ChatGPT',
    })
    expect(parseCodexStatus(false, 'Logged in using ChatGPT', 'failed', '2.0').loggedIn).toBe(false)
    expect(parseCodexStatus(false, '', 'Not logged in', null).error).toBeNull()
  })

  it('rejects API-key and unknown billing modes for subscription-only runs', () => {
    const claudeApi = parseClaudeStatus(
      '{"loggedIn":true,"authMethod":"apiKey","apiProvider":"firstParty"}',
      '',
      '1.2.3',
    )
    expect(claudeApi.billingMode).toBe('api_key')
    expect(subscriptionAuthError('Claude Code', claudeApi)).toMatch(/API-key\/provider billing/)

    const codexApi = parseCodexStatus(true, 'Logged in using API key', '', '2.0')
    expect(codexApi.billingMode).toBe('api_key')
    expect(subscriptionAuthError('Codex', codexApi)).toMatch(/API-key\/provider billing/)

    const unknown = parseCodexStatus(true, 'Logged in using custom profile', '', '2.0')
    expect(unknown.billingMode).toBe('unknown')
    expect(subscriptionAuthError('Codex', unknown)).toMatch(/unrecognized billing mode/)
    expect(subscriptionAuthError('Codex', null)).toMatch(/not connected/)
  })

  it('redacts credential-shaped status, profile, and error strings before display', () => {
    const secret = `ghp_${'d'.repeat(36)}`
    const claude = parseClaudeStatus(JSON.stringify({
      loggedIn: true,
      authMethod: `oauth ${secret}`,
      apiProvider: `provider ${secret}`,
      orgName: `studio ${secret}`,
      email: `person+${secret}@example.test`,
    }), '', `claude ${secret}`)
    expect(JSON.stringify(claude)).not.toContain(secret)
    expect(JSON.stringify(claude)).toContain('[REDACTED]')

    const codex = parseCodexStatus(false, '', `probe failed PASSWORD=two word secret`, `codex ${secret}`)
    expect(codex.error).toBe('probe failed PASSWORD=[REDACTED]')
    expect(JSON.stringify(codex)).not.toContain('two word secret')
  })
})
