import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { INSTALL_SCRIPT_URLS, installEnv, installPlan } from './harness-install'

describe('installPlan', () => {
  it('uses each vendor’s own documented installer over https', () => {
    expect(INSTALL_SCRIPT_URLS.claude).toBe('https://claude.ai/install.sh')
    expect(INSTALL_SCRIPT_URLS.codex).toBe('https://chatgpt.com/codex/install.sh')
    for (const url of Object.values(INSTALL_SCRIPT_URLS)) expect(url.startsWith('https://')).toBe(true)
  })

  it('runs Claude’s installer through bash, as its docs specify', () => {
    const plan = installPlan('claude', 'darwin')
    expect(plan?.displayCommand).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(plan?.command).toBe('/bin/sh')
    expect(plan?.args).toEqual(['-c', 'curl -fsSL https://claude.ai/install.sh | bash'])
  })

  it('runs Codex’s installer through sh, as its docs specify', () => {
    expect(installPlan('codex', 'linux')?.displayCommand).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh')
  })

  it('offers no plan on Windows rather than running a POSIX pipeline there', () => {
    expect(installPlan('claude', 'win32')).toBeNull()
    expect(installPlan('codex', 'win32')).toBeNull()
  })
})

describe('installEnv', () => {
  it('installs into the real home, not the app’s private CLI home', () => {
    const env = installEnv('/Users/someone', { HOME: '/private/app/harnesses/claude', PATH: '/usr/bin' })
    expect(env.HOME).toBe('/Users/someone')
  })

  it('drops the harness overrides that would redirect the install', () => {
    const env = installEnv('/Users/someone', {
      PATH: '/usr/bin',
      CODEX_HOME: '/private/app/harnesses/codex',
      CLAUDE_CONFIG_DIR: '/private/app/harnesses/claude',
      CODEX_INSTALL_DIR: '/private/app/bin',
      ANTHROPIC_API_KEY: 'secret',
    })
    expect(env.CODEX_HOME).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env.CODEX_INSTALL_DIR).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('guarantees the directories curl and sh live in', () => {
    const entries = installEnv('/Users/someone', { PATH: '/opt/custom' }).PATH.split(path.delimiter)
    expect(entries).toContain('/opt/custom')
    expect(entries).toContain('/usr/bin')
    expect(entries).toContain('/bin')
  })

  it('keeps the search path free of relative and empty entries', () => {
    const entries = installEnv('/Users/someone', { PATH: ':relative/bin:/usr/local/bin' }).PATH.split(path.delimiter)
    expect(entries).not.toContain('')
    expect(entries).not.toContain('relative/bin')
    expect(entries).toContain('/usr/local/bin')
  })

  it('does not repeat a directory that is already on the path', () => {
    const entries = installEnv('/Users/someone', { PATH: '/usr/bin:/bin' }).PATH.split(path.delimiter)
    expect(entries.filter((entry) => entry === '/usr/bin')).toHaveLength(1)
  })

  it('runs Codex’s script non-interactively so it cannot block on a prompt', () => {
    expect(installEnv('/Users/someone', { PATH: '/usr/bin' }).CODEX_NON_INTERACTIVE).toBe('true')
  })
})
