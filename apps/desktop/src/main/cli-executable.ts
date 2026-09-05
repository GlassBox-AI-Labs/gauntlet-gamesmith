import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HarnessKind } from '../shared/harness'
import { sanitizedExecutablePath } from './harness-env'

/**
 * Where both vendors' native installers place their launcher. A login shell
 * has this on PATH through a profile edit, but a GUI app started before that
 * edit does not, so a freshly installed CLI would otherwise stay invisible
 * until the whole machine was restarted. Searched after PATH, never instead of
 * it, and every candidate still goes through the same validation.
 */
function userInstallDirectories(homeDir = os.homedir()): string[] {
  return homeDir ? [path.join(homeDir, '.local', 'bin')] : []
}

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
  let current = canonical(directory)
  while (true) {
    try {
      const marker = fs.lstatSync(path.join(current, '.git'))
      if (marker.isDirectory() || marker.isFile()) return true
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
  if (insideRepository(path.dirname(candidate))) return null
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
  const searched = [
    ...(executablePath?.split(path.delimiter) ?? []),
    ...sanitizedExecutablePath(userInstallDirectories(sourceEnv.HOME).join(path.delimiter), unsafeRoots)
      ?.split(path.delimiter) ?? [],
  ]
  for (const directory of searched) {
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
