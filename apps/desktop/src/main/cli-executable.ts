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

export const DELEGATED_CLI_EXECUTABLE_ENV_KEYS: Record<HarnessKind, 'GAUNTLET_CLAUDE_BIN' | 'GAUNTLET_CODEX_BIN' | 'GAUNTLET_GROK_BIN'> = {
  claude: 'GAUNTLET_CLAUDE_BIN',
  codex: 'GAUNTLET_CODEX_BIN',
  grok: 'GAUNTLET_GROK_BIN',
}

/** Pinned PATH entry per CLI — the launcher path, not the version file behind it. */
const cached = new Map<HarnessKind, string>()

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

/**
 * The directories agents can write into: every run folder the app manages, plus
 * the parent it creates new ones in.
 *
 * This used to be "any directory under a git checkout", which rejected the real
 * threat — an agent planting `claude` in the project it is building — but also
 * rejected Homebrew, whose prefix is itself a git repository, making a
 * `brew install --cask claude-code` invisible to the app. Naming the roots the
 * app actually controls covers the threat without guessing from a `.git`
 * marker that says nothing about who can write there.
 */
let agentWritableRoots: () => readonly string[] = () => []

export function configureAgentWritableRoots(provider: () => readonly string[]): void {
  agentWritableRoots = provider
}

export function clearAgentWritableRootsForTest(): void {
  agentWritableRoots = () => []
}

/**
 * Callers name the roots they know about; this adds the ones the app tracks
 * globally. A provider that fails must not make every CLI unresolvable, so its
 * failure falls back to the caller's own roots — which on the run path already
 * include the workspace being built.
 */
function effectiveRoots(unsafeRoots: readonly string[]): string[] {
  let tracked: readonly string[] = []
  try {
    tracked = agentWritableRoots()
  } catch {
    tracked = []
  }
  return [...new Set([...unsafeRoots, ...tracked])]
}

/** The canonical executable a candidate path currently resolves to, or null if it is not a safe installed CLI. */
function validateCandidate(candidate: string, unsafeRoots: readonly string[]): string | null {
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
  return real
}

/** Pure resolver used by tests and the process-wide pinned registry below. */
export function resolveCliExecutable(
  kind: HarnessKind,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  unsafeRoots: readonly string[] = [],
): { candidate: string; path: string } {
  // Each CLI's launcher is named after its harness.
  const binary = kind
  const roots = effectiveRoots(unsafeRoots)
  const executablePath = sanitizedExecutablePath(sourceEnv.PATH, roots)
  const searched = [
    ...(executablePath?.split(path.delimiter) ?? []),
    ...sanitizedExecutablePath(userInstallDirectories(sourceEnv.HOME).join(path.delimiter), roots)
      ?.split(path.delimiter) ?? [],
  ]
  for (const directory of searched) {
    const candidate = path.join(directory, binary)
    const resolved = validateCandidate(candidate, roots)
    if (resolved) return { candidate, path: resolved }
  }
  throw new Error(`${binary} was not found as an installed executable outside project and private app directories.`)
}

/**
 * Search PATH once, pin the installed launcher path, then revalidate it for
 * every later status/login/run spawn. This removes all bare-name PATH lookups
 * after an agent has had a chance to write executable project content, while
 * still following the CLI's own updater: `claude update` repoints
 * ~/.local/bin/claude at a new version file, and pinning the version file
 * instead would keep spawning the superseded binary until the app restarts.
 * Every re-resolution revalidates the same safety rules as the first.
 *
 * What is returned is the launcher, not the file it resolves to. Some launchers
 * decide what to run from the name they were called as: a Volta-managed `codex`
 * is a symlink to `volta-shim`, and spawning that real path directly makes it
 * exit with "volta-shim should not be called directly", so the CLI looked
 * missing. Validation still follows the link — only the spawned path changed.
 */
export function cliExecutable(
  kind: HarnessKind,
  unsafeRoots: readonly string[] = [],
  sourceEnv: NodeJS.ProcessEnv = process.env,
): string {
  const pinned = cached.get(kind)
  if (pinned) {
    if (!validateCandidate(pinned, effectiveRoots(unsafeRoots))) {
      throw new Error(`The installed ${kind} executable at ${pinned} is no longer a safe installed executable; verify the CLI installation.`)
    }
    return pinned
  }
  const resolved = resolveCliExecutable(kind, sourceEnv, unsafeRoots)
  cached.set(kind, resolved.candidate)
  return resolved.candidate
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
  const roots = effectiveRoots(unsafeRoots)
  for (const [kind, executable] of executables) {
    // The launcher itself may be a symlink (see cliExecutable), so this checks
    // the shape of the path and revalidates what it resolves to, rather than
    // demanding that the two be the same file.
    if (!path.isAbsolute(executable) || path.normalize(executable) !== executable) {
      throw new Error(`The pinned ${kind} executable must be an absolute canonical path.`)
    }
    if (!validateCandidate(executable, roots)) {
      throw new Error(`The pinned ${kind} executable is no longer a safe installed executable.`)
    }
    env[DELEGATED_CLI_EXECUTABLE_ENV_KEYS[kind]] = executable
  }
  return env
}

export function clearCliExecutableCacheForTest(): void {
  cached.clear()
}
