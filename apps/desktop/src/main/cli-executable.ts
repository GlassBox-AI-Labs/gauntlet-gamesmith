import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { HarnessKind } from '../shared/harness'
import { sanitizedExecutablePath } from './harness-env'

interface ExecutableIdentity {
  path: string
  dev: number
  ino: number
}

export const DELEGATED_CLI_EXECUTABLE_ENV_KEYS: Record<HarnessKind, 'GAUNTLET_CLAUDE_BIN' | 'GAUNTLET_CODEX_BIN'> = {
  claude: 'GAUNTLET_CLAUDE_BIN',
  codex: 'GAUNTLET_CODEX_BIN',
}

const cached = new Map<HarnessKind, ExecutableIdentity>()

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function canonical(value: string): string {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

function insideRepository(directory: string): boolean {
  const installedDirectory = canonical(directory)
  const nvmRoot = canonical(path.join(os.homedir(), '.nvm'))
  const nvmRelative = path.relative(nvmRoot, installedDirectory).split(path.sep).join('/')
  // NVM itself is a Git checkout. Its versioned global installation trees
  // are not projects; ignore only that marker, never a nested/parent repo.
  const nvmInstallation = /^versions\/node\/v\d+\.\d+\.\d+\/(?:bin|lib\/node_modules)(?:\/|$)/.test(nvmRelative)
  let current = installedDirectory
  while (true) {
    try {
      const marker = fs.lstatSync(path.join(current, '.git'))
      if ((marker.isDirectory() || marker.isFile()) && !(current === nvmRoot && nvmInstallation)) return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true
    }
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function validateCandidate(candidate: string, unsafeRoots: readonly string[]): ExecutableIdentity | null {
  let real: string
  let stat: fs.Stats
  try {
    real = fs.realpathSync(candidate)
    stat = fs.statSync(real)
  } catch {
    return null
  }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) return null
  const roots = unsafeRoots.map(canonical)
  if (roots.some((root) => inside(root, real) || inside(root, canonical(candidate)))) return null
  // PATH entries inside a checked-out repository are agent-writable project
  // content, not installed CLIs. Continue to the next installed candidate.
  if (insideRepository(path.dirname(candidate)) || insideRepository(path.dirname(real))) return null
  return { path: real, dev: stat.dev, ino: stat.ino }
}

/** Pure resolver used by tests and the process-wide pinned registry below. */
export function resolveCliExecutable(
  kind: HarnessKind,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  unsafeRoots: readonly string[] = [],
): ExecutableIdentity {
  const binary = kind === 'claude' ? 'claude' : 'codex'
  const executablePath = sanitizedExecutablePath(sourceEnv.PATH, unsafeRoots)
  for (const directory of executablePath?.split(path.delimiter) ?? []) {
    const resolved = validateCandidate(path.join(directory, binary), unsafeRoots)
    if (resolved) return resolved
  }
  throw new Error(`${binary} was not found as an installed executable outside project and private app directories.`)
}

/**
 * Resolve each stock CLI once, then require the same inode for every later
 * status/login/run spawn. This removes all bare-name PATH lookups after an
 * agent has had a chance to write executable project content.
 */
export function cliExecutable(
  kind: HarnessKind,
  unsafeRoots: readonly string[] = [],
  sourceEnv: NodeJS.ProcessEnv = process.env,
): string {
  const prior = cached.get(kind)
  if (prior) {
    const current = validateCandidate(prior.path, unsafeRoots)
    if (!current || current.dev !== prior.dev || current.ino !== prior.ino) {
      throw new Error(`The installed ${kind} executable changed identity; restart after verifying the CLI installation.`)
    }
    return prior.path
  }
  const resolved = resolveCliExecutable(kind, sourceEnv, unsafeRoots)
  cached.set(kind, resolved)
  return resolved.path
}

/**
 * Build the private executable handoff used by delegated workers. Generic
 * process/plan environment values never reach these keys; callers must first
 * obtain each value from cliExecutable (or the injected equivalent), and this
 * boundary revalidates that it is still a canonical installed executable.
 */
export function validatedExecutableEnv(
  executables: ReadonlyMap<HarnessKind, string>,
  unsafeRoots: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [kind, executable] of executables) {
    if (!path.isAbsolute(executable) || canonical(executable) !== path.normalize(executable)) {
      throw new Error(`The pinned ${kind} executable must be an absolute canonical path.`)
    }
    const current = validateCandidate(executable, unsafeRoots)
    if (!current || current.path !== executable) {
      throw new Error(`The pinned ${kind} executable is no longer a safe installed executable.`)
    }
    env[DELEGATED_CLI_EXECUTABLE_ENV_KEYS[kind]] = current.path
  }
  return env
}

export function clearCliExecutableCacheForTest(): void {
  cached.clear()
}
