import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliHomeEnv, runsDir, safeCliHome, sanitizedExecutablePath, subscriptionEnv } from './harness-env'

it('keeps harness-home environment keys canonical', () => {
  expect(cliHomeEnv('claude', '/private/claude')).toEqual({ CLAUDE_CONFIG_DIR: '/private/claude' })
  expect(cliHomeEnv('codex', '/private/codex')).toEqual({ CODEX_HOME: '/private/codex' })
})

describe('subscriptionEnv', () => {
  it('inherits only reviewed process basics and isolates the selected harness home', () => {
    const env = subscriptionEnv(
      { CLAUDE_CONFIG_DIR: '/private/claude' },
      {
        PATH: '/private/claude/bin:/usr/bin',
        LANG: 'en_US.UTF-8',
        SECRET: 'private',
        AWS_SECRET_ACCESS_KEY: 'private',
        GITHUB_TOKEN: 'private',
        SSH_AUTH_SOCK: '/private/agent.sock',
        NODE_OPTIONS: '--require attacker.js',
        HOME: '/Users/operator',
        GAUNTLET_CLAUDE_BIN: '/attacker/claude',
        GAUNTLET_CODEX_BIN: '/attacker/codex',
      },
      'claude',
    )

    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      CLAUDE_CONFIG_DIR: '/private/claude',
      HOME: '/private/claude',
      USERPROFILE: '/private/claude',
      NO_COLOR: '1',
    })
  })

  it('drops arbitrary and billing-sensitive overrides while retaining reviewed plan fields', () => {
    const env = subscriptionEnv(
      {
        OPENAI_API_KEY: 'override',
        anthropic_auth_token: 'override-lowercase',
        CODEX_HOME: '/private/codex',
        BASH_MAX_TIMEOUT_MS: '1000',
        GITHUB_TOKEN: 'override',
        GAUNTLET_CODEX_BIN: '/attacker/codex',
      },
      { openai_base_url: 'https://attacker.invalid', PATH: '/bin' },
      'codex',
    )

    expect(env).toEqual({
      PATH: '/bin',
      CODEX_HOME: '/private/codex',
      BASH_MAX_TIMEOUT_MS: '1000',
      HOME: '/private/codex',
      USERPROFILE: '/private/codex',
      NO_COLOR: '1',
    })
  })

  it('removes empty and relative PATH entries that could resolve a workspace-planted CLI', () => {
    expect(sanitizedExecutablePath(`.:relative::/usr/local/bin:/usr/bin:/usr/bin`)).toBe('/usr/local/bin:/usr/bin')
    const env = subscriptionEnv({ CODEX_HOME: '/private/codex' }, { PATH: '.::relative' }, 'codex')
    expect(env).not.toHaveProperty('PATH')
  })

  it('removes absolute PATH entries inside an agent-writable workspace, including aliases', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-path-workspace-'))
    const workspace = path.join(root, 'workspace')
    const bin = path.join(workspace, 'bin')
    const alias = path.join(root, 'alias-bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.symlinkSync(bin, alias)
    try {
      const env = subscriptionEnv(
        { CLAUDE_CONFIG_DIR: '/private/claude' },
        { PATH: `${bin}:${alias}:/usr/bin` },
        'claude',
        [workspace],
      )
      expect(env.PATH).toBe('/usr/bin')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

it('refuses to create the run directory through a planted metadata symlink', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-runs-workspace-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-runs-outside-'))
  fs.symlinkSync(outside, path.join(workspace, '.gauntlet-gamesmith'))
  try {
    expect(() => runsDir(workspace)).toThrow(/must be a real directory/)
    expect(fs.readdirSync(outside)).toEqual([])
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

it('refuses to use or chmod a planted CLI-home symlink', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-user-data-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cli-outside-'))
  fs.chmodSync(outside, 0o755)
  fs.mkdirSync(path.join(userData, 'harnesses'))
  fs.symlinkSync(outside, path.join(userData, 'harnesses', 'claude'))
  try {
    expect(() => safeCliHome(userData, 'claude')).toThrow(/must be a real directory/)
    expect(fs.statSync(outside).mode & 0o777).not.toBe(0o700)
  } finally {
    fs.rmSync(userData, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})
