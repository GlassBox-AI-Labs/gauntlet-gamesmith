import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { HarnessKind } from '../shared/harness'
import { prepareAccountDir, readAccounts, sharedDir } from './accounts'
import { bundledSkillDir, installSkill, type SkillInstall } from './skills'
import { safeWorkspaceMetadataDir } from './workspace-metadata'

export const CLI_HOME_ENV_KEYS: Record<HarnessKind, 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
}

export function cliHomeEnv(kind: HarnessKind, home: string): Record<string, string> {
  return { [CLI_HOME_ENV_KEYS[kind]]: home }
}

/** Root containing every app-managed CLI home; accepts injected test homes. */
export function cliPrivateRoot(home: string): string {
  let current = path.resolve(home)
  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'harnesses') return path.dirname(current)
    current = path.dirname(current)
  }
  return path.resolve(home)
}

export function safeCliHome(userDataDir: string, kind: HarnessKind): string {
  const root = fs.realpathSync(userDataDir)
  let current = root
  for (const segment of ['harnesses', kind]) {
    current = path.join(current, segment)
    try {
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`CLI home component ${segment} must be a real directory.`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      fs.mkdirSync(current, { mode: 0o700 })
    }
    if (fs.realpathSync(current) !== current) throw new Error(`CLI home component ${segment} resolves outside its canonical path.`)
    fs.chmodSync(current, 0o700)
  }
  return current
}

export function harnessesRoot(): string {
  return path.join(app.getPath('userData'), 'harnesses')
}

/** The config dir holding the login of the harness's active account. */
export function cliHome(kind: HarnessKind): string {
  const root = harnessesRoot()
  return prepareAccountDir(root, kind, readAccounts(root, kind).activeId)
}

/**
 * Session transcripts and installed skills, which every account reads and
 * writes through.
 *
 * Keeping these out of the per-account credential dir is what lets a build
 * switch accounts between rounds and still `--continue` the same session.
 */
export function sharedHome(kind: HarnessKind): string {
  const root = harnessesRoot()
  prepareAccountDir(root, kind, readAccounts(root, kind).activeId)
  return sharedDir(root, kind)
}

/**
 * Put the vendored `img2threejs` skill where the Claude CLI will find it.
 *
 * Installed into the *shared* home, not the active account's. Every account
 * reaches `skills/` through the same store — the primary account's dir is that
 * store, and the others symlink into it — so installing once here is what makes
 * a mid-build account switch keep finding the skill. Installing into
 * `cliHome()` would land in whichever account happened to be active and only
 * reach the shared store by symlink, which `prepareAccountDir` declines to
 * create when a real directory is already sitting there.
 *
 * Packaged, the source is the `extraResources` copy under `resourcesPath`; in
 * dev it is `vendor/` in the repo.
 */
export function ensureSkill(): SkillInstall {
  return installSkill(sharedHome('claude'), bundledSkillDir(app.isPackaged ? process.resourcesPath : null, __dirname))
}

/** Attempt transcripts live with the project so a folder transfer is complete. */
export function attemptsDir(workspaceDir: string, create = true): string {
  return safeWorkspaceMetadataDir(workspaceDir, ['builds'], create)
}

/** Non-secret process basics required to find binaries and run terminal tools. */
const INHERITED_CLI_ENV = new Set([
  'PATH',
  // macOS resolves the login keychain through HOME. Claude Code keeps its
  // subscription credentials there, so a rewritten HOME made the CLI ask for a
  // keychain that does not exist and macOS offered to reset the user's real
  // one. Isolation comes from CLAUDE_CONFIG_DIR and CODEX_HOME instead, which
  // is what each CLI documents for exactly this purpose.
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'SHELL',
  'TZ',
])

/** Explicit plan fields reviewed as safe for subscription-authenticated attempts. */
const PLAN_CLI_ENV = new Set([
  ...Object.values(CLI_HOME_ENV_KEYS),
  'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'BASH_MAX_TIMEOUT_MS',
  'BASH_DEFAULT_TIMEOUT_MS',
])

function canonicalIfPresent(value: string): string {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function sanitizedExecutablePath(value: string | undefined, unsafeRoots: readonly string[] = []): string | undefined {
  if (value === undefined) return undefined
  const roots = unsafeRoots.map(canonicalIfPresent)
  const safe = [...new Set(value.split(path.delimiter).filter((entry) => {
    if (entry.length === 0 || !path.isAbsolute(entry)) return false
    const candidate = canonicalIfPresent(entry)
    return roots.every((root) => !inside(root, candidate))
  }))]
  return safe.length > 0 ? safe.join(path.delimiter) : undefined
}

export function subscriptionEnv(
  overrides: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
  selectedHarness?: HarnessKind,
  unsafeExecutableRoots: readonly string[] = [],
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && INHERITED_CLI_ENV.has(entry[0].toUpperCase()),
    ),
  )
  const candidateHomes = selectedHarness
    ? [overrides[CLI_HOME_ENV_KEYS[selectedHarness]]]
    : Object.values(CLI_HOME_ENV_KEYS).map((key) => overrides[key]).filter(Boolean)
  const safePath = sanitizedExecutablePath(env.PATH, [
    ...unsafeExecutableRoots,
    ...candidateHomes.filter((home): home is string => home !== undefined),
  ])
  if (safePath) env.PATH = safePath
  else delete env.PATH
  for (const [key, value] of Object.entries(overrides)) {
    if (PLAN_CLI_ENV.has(key)) env[key] = value
  }
  return { ...env, NO_COLOR: '1' }
}
