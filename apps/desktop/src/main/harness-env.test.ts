import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliHomeEnv, linkLoginKeychain, runsDir, safeCliHome, sanitizedExecutablePath, subscriptionEnv, voltaHomeEnv } from './harness-env'

it('keeps harness-home environment keys canonical', () => {
  expect(cliHomeEnv('claude', '/private/claude')).toEqual({ CLAUDE_CONFIG_DIR: '/private/claude' })
  expect(cliHomeEnv('codex', '/private/codex')).toEqual({ CODEX_HOME: '/private/codex' })
})

it.runIf(process.platform === 'darwin')('lets the isolated home resolve the real login keychain', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keychain-link-'))
  const realHome = path.join(base, 'real')
  const home = path.join(base, 'harnesses', 'claude')
  fs.mkdirSync(path.join(realHome, 'Library', 'Keychains'), { recursive: true })
  fs.mkdirSync(home, { recursive: true })

  linkLoginKeychain(home, realHome)
  linkLoginKeychain(home, realHome)

  const link = path.join(home, 'Library', 'Keychains')
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(realHome, 'Library', 'Keychains')))
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
      HOME: '/Users/operator',
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
      NO_COLOR: '1',
    })
  })

  it('keeps the real home so macOS can find the login keychain', () => {
    // Claude Code stores subscription credentials in the macOS login keychain,
    // which the Security framework locates through HOME. Pointing HOME at the
    // app's private CLI home made macOS report "a default keychain could not
    // be found" and offer to reset the user's real keychain.
    const env = subscriptionEnv(
      { CLAUDE_CONFIG_DIR: '/private/claude' },
      { HOME: '/Users/operator', USERPROFILE: '/Users/operator', PATH: '/usr/bin' },
      'claude',
    )

    expect(env.HOME).toBe('/Users/operator')
    expect(env.USERPROFILE).toBe('/Users/operator')
    // Isolation still comes from the documented config-dir variable.
    expect(env.CLAUDE_CONFIG_DIR).toBe('/private/claude')
  })

  it('leaves the home unset when the parent process has none, rather than inventing one', () => {
    const env = subscriptionEnv({ CODEX_HOME: '/private/codex' }, { PATH: '/usr/bin' }, 'codex')
    expect(env).not.toHaveProperty('HOME')
    expect(env.CODEX_HOME).toBe('/private/codex')
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

it('points Volta shims at the real toolchain when a plan isolates HOME', () => {
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-real-home-'))
  const voltaHome = path.join(realHome, '.volta')
  try {
    expect(voltaHomeEnv({ HOME: realHome })).toEqual({})
    fs.mkdirSync(path.join(voltaHome, 'bin'), { recursive: true })
    expect(voltaHomeEnv({ HOME: realHome })).toEqual({ VOLTA_HOME: voltaHome })
    expect(voltaHomeEnv({ HOME: realHome, VOLTA_HOME: voltaHome })).toEqual({ VOLTA_HOME: voltaHome })
    // Claude and Codex keep the real home so sign-in reaches the login keychain (ADR-016).
    expect(subscriptionEnv({ CODEX_HOME: '/private/codex' }, { HOME: realHome }, 'codex')).toMatchObject({
      HOME: realHome,
      VOLTA_HOME: voltaHome,
    })
    // Only the grok plan isolates HOME, and its shims still need the real toolchain.
    expect(subscriptionEnv({ GROK_HOME: '/private/grok', HOME: '/private/neutral' }, { HOME: realHome }, 'grok')).toMatchObject({
      HOME: '/private/neutral',
      VOLTA_HOME: voltaHome,
    })
  } finally {
    fs.rmSync(realHome, { recursive: true, force: true })
  }
})
