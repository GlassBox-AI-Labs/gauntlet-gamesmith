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

  it('resolves and keeps pinned a CLI installed under a git-managed Homebrew prefix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cli-brew-'))
    roots.push(root)
    const prefix = path.join(root, 'homebrew')
    // Homebrew self-manages its prefix with git and ships a brew launcher + Cellar.
    fs.mkdirSync(path.join(prefix, '.git'), { recursive: true })
    fs.mkdirSync(path.join(prefix, 'Cellar'), { recursive: true })
    executable(path.join(prefix, 'bin', 'brew'))
    executable(path.join(prefix, 'bin', 'codex'))
    const source = { PATH: path.join(prefix, 'bin') }

    const resolved = resolveCliExecutable('codex', source)
    expect(resolved.path).toBe(fs.realpathSync(path.join(prefix, 'bin', 'codex')))

    // The pinned real path lives under the git-managed prefix; re-validation must
    // not trip the "changed identity" guard on a subsequent probe.
    const pinned = cliExecutable('codex', [], source)
    expect(pinned).toBe(fs.realpathSync(path.join(prefix, 'bin', 'codex')))
    expect(cliExecutable('codex', [], source)).toBe(pinned)
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
