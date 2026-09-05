import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearCliExecutableCacheForTest,
  cliExecutable,
  resolveCliExecutable,
  validatedExecutableEnv,
} from './cli-executable'

const roots: string[] = []

function executable(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
}

afterEach(() => {
  vi.restoreAllMocks()
  clearCliExecutableCacheForTest()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('CLI executable resolution', () => {
  it('skips a repository-planted binary and pins the installed real path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cli-resolution-'))
    roots.push(root)
    const repository = path.join(root, 'project')
    const installed = path.join(root, 'installed')
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true })
    executable(path.join(repository, 'bin', 'claude'))
    executable(path.join(installed, 'claude'))

    const resolved = resolveCliExecutable('claude', { PATH: `${path.join(repository, 'bin')}:${installed}` })
    expect(resolved.path).toBe(fs.realpathSync(path.join(installed, 'claude')))
  })

  it('rejects protected paths and detects replacement after pinning', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cli-identity-'))
    roots.push(root)
    const protectedDir = path.join(root, 'workspace', 'bin')
    const installed = path.join(root, 'installed')
    executable(path.join(protectedDir, 'codex'))
    executable(path.join(installed, 'codex'))
    const source = { PATH: `${protectedDir}:${installed}` }

    const pinned = cliExecutable('codex', [path.join(root, 'workspace')], source)
    expect(pinned).toBe(fs.realpathSync(path.join(installed, 'codex')))
    fs.renameSync(pinned, `${pinned}.old`)
    executable(pinned)
    expect(() => cliExecutable('codex', [path.join(root, 'workspace')], source)).toThrow(/changed identity/)
  })

  it('constructs delegated binary variables only from canonical safe executables', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cli-env-'))
    roots.push(root)
    const installed = path.join(root, 'installed')
    const workspace = path.join(root, 'workspace')
    executable(path.join(installed, 'claude'))
    executable(path.join(workspace, 'codex'))

    const claude = cliExecutable('claude', [workspace], { PATH: installed })
    expect(validatedExecutableEnv(new Map([['claude', claude]]), [workspace])).toEqual({
      GAUNTLET_CLAUDE_BIN: claude,
    })
    expect(() => validatedExecutableEnv(new Map([['codex', 'relative/codex']]), [workspace])).toThrow(/absolute canonical/)
    expect(() => validatedExecutableEnv(new Map([['codex', path.join(workspace, 'codex')]]), [workspace])).toThrow(
      /absolute canonical|safe installed executable/,
    )
  })
})


describe('NVM global CLI installations', () => {
  it('accepts installed global CLIs beneath NVM’s own Git checkout, including cached real paths', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-nvm-'))
    roots.push(home)
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const nvm = path.join(home, '.nvm')
    const version = path.join(nvm, 'versions/node/v22.23.1')
    fs.mkdirSync(path.join(nvm, '.git'), { recursive: true })
    const installed = path.join(version, 'lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe')
    executable(installed)
    fs.mkdirSync(path.join(version, 'bin'), { recursive: true })
    fs.symlinkSync(installed, path.join(version, 'bin/claude'))
    const env = { PATH: path.join(version, 'bin') }
    expect(cliExecutable('claude', [], env)).toBe(fs.realpathSync(installed))
    expect(cliExecutable('claude', [], env)).toBe(fs.realpathSync(installed))
    expect(() => resolveCliExecutable('claude', env, [version])).toThrow(/not found/)
    fs.mkdirSync(path.join(version, 'lib/node_modules/@anthropic-ai/claude-code/.git'))
    expect(() => resolveCliExecutable('claude', env)).toThrow(/not found/)
  })

  it('rejects project links, other NVM directories, and repositories above the NVM root', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-nvm-project-'))
    roots.push(home)
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const nvm = path.join(home, '.nvm')
    fs.mkdirSync(path.join(nvm, '.git'), { recursive: true })
    executable(path.join(nvm, 'project/bin/claude'))
    expect(() => resolveCliExecutable('claude', { PATH: path.join(nvm, 'project/bin') })).toThrow(/not found/)
    const bin = path.join(nvm, 'versions/node/v22.23.1/bin')
    const project = path.join(home, 'project')
    fs.mkdirSync(path.join(project, '.git'), { recursive: true })
    executable(path.join(project, 'claude'))
    fs.mkdirSync(bin, { recursive: true })
    fs.symlinkSync(path.join(project, 'claude'), path.join(bin, 'claude'))
    expect(() => resolveCliExecutable('claude', { PATH: bin })).toThrow(/not found/)
    executable(path.join(bin, 'codex'))
    fs.mkdirSync(path.join(home, '.git'))
    expect(() => resolveCliExecutable('codex', { PATH: bin })).toThrow(/not found/)
  })
})
