import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearAgentWritableRootsForTest,
  clearCliExecutableCacheForTest,
  cliExecutable,
  configureAgentWritableRoots,
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
  clearAgentWritableRootsForTest()
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
  it('skips a binary planted in a run workspace and pins the installed real path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cli-resolution-'))
    roots.push(root)
    const workspace = path.join(root, 'project')
    const installed = path.join(root, 'installed')
    executable(path.join(workspace, 'bin', 'claude'))
    executable(path.join(installed, 'claude'))
    configureAgentWritableRoots(() => [workspace])

    const resolved = resolveCliExecutable('claude', { PATH: `${path.join(workspace, 'bin')}:${installed}`, HOME: root })
    expect(resolved.path).toBe(fs.realpathSync(path.join(installed, 'claude')))
  })

  it('uses a CLI installed under a git checkout that is not agent-writable', () => {
    // Homebrew's own prefix is a git repository, so rejecting every directory
    // under a `.git` marker made `brew install --cask claude-code` invisible.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cli-brew-'))
    roots.push(root)
    const prefix = path.join(root, 'homebrew')
    fs.mkdirSync(path.join(prefix, '.git'), { recursive: true })
    executable(path.join(prefix, 'bin', 'claude'))

    const resolved = resolveCliExecutable('claude', { PATH: path.join(prefix, 'bin'), HOME: root })
    expect(resolved.path).toBe(fs.realpathSync(path.join(prefix, 'bin', 'claude')))
  })

  it('rejects a planted binary even when the caller names no roots itself', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cli-tracked-'))
    roots.push(root)
    const workspace = path.join(root, 'run-folder')
    executable(path.join(workspace, 'bin', 'codex'))
    configureAgentWritableRoots(() => [workspace])

    expect(() => resolveCliExecutable('codex', { PATH: path.join(workspace, 'bin'), HOME: root })).toThrow(/not found/)
  })

  it('falls back to the caller’s roots when the tracked-root lookup fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-cli-provider-fail-'))
    roots.push(root)
    const workspace = path.join(root, 'run-folder')
    const installed = path.join(root, 'installed')
    executable(path.join(workspace, 'bin', 'claude'))
    executable(path.join(installed, 'claude'))
    configureAgentWritableRoots(() => { throw new Error('ledger is closed') })

    const resolved = resolveCliExecutable('claude', { PATH: `${path.join(workspace, 'bin')}:${installed}`, HOME: root }, [workspace])
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
    configureAgentWritableRoots(() => [path.join(version, 'lib/node_modules/@anthropic-ai/claude-code')])
    expect(() => resolveCliExecutable('claude', env)).toThrow(/not found/)
  })

  it('rejects project links and NVM directories registered as agent-writable', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-nvm-project-'))
    roots.push(home)
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const nvm = path.join(home, '.nvm')
    fs.mkdirSync(path.join(nvm, '.git'), { recursive: true })
    configureAgentWritableRoots(() => [path.join(nvm, 'project'), path.join(home, 'project')])
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
    configureAgentWritableRoots(() => [home])
    expect(() => resolveCliExecutable('codex', { PATH: bin })).toThrow(/not found/)
  })
})
