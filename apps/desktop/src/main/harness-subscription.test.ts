import type { SpawnSyncReturns } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { subscriptionReadiness, type StatusCommand } from './harness-subscription'

function result(stdout: string, stderr = '', status = 0): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
    error: undefined,
  }
}

describe('subscriptionReadiness', () => {
  it('accepts only a Claude subscription profile and uses the isolated home', () => {
    const command = vi.fn<StatusCommand>(() => result('{"loggedIn":true,"authMethod":"oauth","subscriptionType":"max"}'))
    expect(subscriptionReadiness('claude', '/workspace', '/private/claude', {
      PATH: '.:/workspace/bin:/usr/bin',
      AWS_SECRET_ACCESS_KEY: 'secret',
    }, command, () => '/installed/claude')).toEqual({ ok: true, error: null })

    expect(command).toHaveBeenCalledWith('/installed/claude', ['auth', 'status', '--json'], expect.objectContaining({
      cwd: '/workspace',
      env: expect.objectContaining({
        PATH: '/usr/bin',
        HOME: '/private/claude',
        CLAUDE_CONFIG_DIR: '/private/claude',
      }),
    }))
    const env = command.mock.calls[0][2].env
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })

  it('rejects API-key, unknown, and disconnected profiles', () => {
    expect(subscriptionReadiness('claude', '/workspace', '/private/claude', {}, () =>
      result('{"loggedIn":true,"authMethod":"apiKey","apiProvider":"firstParty"}'), () => '/installed/claude').error).toMatch(/API-key/)
    expect(subscriptionReadiness('codex', '/workspace', '/private/codex', {}, () =>
      result('Logged in using custom profile'), () => '/installed/codex').error).toMatch(/unrecognized billing mode/)
    expect(subscriptionReadiness('codex', '/workspace', '/private/codex', {}, () =>
      result('Not logged in', '', 1), () => '/installed/codex').error).toMatch(/not connected/)
  })
})
