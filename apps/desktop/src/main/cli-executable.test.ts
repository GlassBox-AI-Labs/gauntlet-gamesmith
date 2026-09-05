import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
  clearCliExecutableCacheForTest()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('newly installed CLIs', () => {
  it('finds a binary the native installer put in ~/.local/bin but not on PATH', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cli-userbin-'))
    roots.push(root)
    const home = path.join(root, 'home')
    const elsewhere = path.join(root, 'elsewhere')
    fs.mkdirSync(elsewhere, { recursive: true })
    executable(path.join(home, '.local', 'bin', 'claude'))

    const resolved = resolveCliExecutable('claude', { PATH: elsewhere, HOME: home })
    expect(resolved.path).toBe(fs.realpathSync(path.join(home, '.local', 'bin', 'claude')))
  })

  it('still prefers a PATH entry over the install directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cli-userbin-order-'))
    roots.push(root)
    const home = path.join(root, 'home')
    const onPath = path.join(root, 'usr-local-bin')
    executable(path.join(onPath, 'codex'))
    executable(path.join(home, '.local', 'bin', 'codex'))

    const resolved = resolveCliExecutable('codex', { PATH: onPath, HOME: home })
    expect(resolved.path).toBe(fs.realpathSync(path.join(onPath, 'codex')))
  })

  it('does not use an install directory inside a protected app root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cli-userbin-unsafe-'))
    roots.push(root)
    const home = path.join(root, 'private-home')
    executable(path.join(home, '.local', 'bin', 'claude'))

    expect(() => resolveCliExecutable('claude', { PATH: '', HOME: home }, [home])).toThrow(/not found/)
  })
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
