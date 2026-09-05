import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { HarnessKind } from '../shared/harness'
import { prepareAccountDir, readAccounts, sharedDir } from './accounts'
import { bundledSkillDir, installSkill, type SkillInstall } from './skills'
import { safeWorkspaceMetadataDir } from './workspace-metadata'

export const CLI_HOME_ENV_KEYS: Record<HarnessKind, 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' | 'GROK_HOME'> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  grok: 'GROK_HOME',
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

/**
 * Let the isolated HOME reach the real macOS login keychain.
 *
 * macOS finds the keychain search list through `$HOME`, so pointing HOME at the
 * private config dir leaves the CLI with no default keychain: signing in raises
 * a "Keychain Not Found" panel over the app and the credentials fall back to a
 * plaintext file. One link restores the lookup without exposing the rest of the
 * operator's home. Accounts stay separate either way — the Claude CLI names its
 * keychain item after the config dir it was signed in with.
 */
export function linkLoginKeychain(home: string, realHome: string = os.homedir()): void {
  if (process.platform !== 'darwin') return
  const link = path.join(home, 'Library', 'Keychains')
  try {
    if (fs.existsSync(link)) return
    fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 })
    fs.symlinkSync(path.join(realHome, 'Library', 'Keychains'), link, 'dir')
  } catch {
    /* without the link the CLI falls back to its own credential file */
  }
}

/** The config dir holding the login of the harness's active account. */
export function cliHome(kind: HarnessKind): string {
  const root = harnessesRoot()
  const home = prepareAccountDir(root, kind, readAccounts(root, kind).activeId)
  linkLoginKeychain(home)
  return home
}

/**
 * Session transcripts and installed skills, which every account reads and
 * writes through.
 *
 * Keeping these out of the per-account credential dir is what lets a run
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
 * a mid-loop account switch keep finding the skill. Installing into
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

/** Run transcripts live with the project so a folder transfer is complete. */
export function runsDir(workspaceDir: string, create = true): string {
  return safeWorkspaceMetadataDir(workspaceDir, ['runs'], create)
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

/** Explicit plan fields reviewed as safe for subscription-authenticated runs. */
const PLAN_CLI_ENV = new Set([
  ...Object.values(CLI_HOME_ENV_KEYS),
  // Only the grok plan sets HOME, and only to the neutral home (see `neutralHome`).
  // Claude and Codex inherit the real home so their sign-in reaches the login keychain (ADR-016).
  'HOME',
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

/**
 * Keep node version managers working under an isolated HOME.
 *
 * `node`, `npm` and `codex` on the operator's PATH can be Volta shims, and a
 * shim finds its toolchain through `$VOLTA_HOME`, defaulting to `$HOME/.volta`.
 * Every child here gets a private HOME, so the shim looks in an empty sandbox
 * and dies with "Node is not available" (exit 126). Pointing VOLTA_HOME back at
 * the real install exposes nothing PATH did not already expose.
 */
export function voltaHomeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const voltaHome = source.VOLTA_HOME ?? (source.HOME ? path.join(source.HOME, '.volta') : undefined)
  return voltaHome && fs.existsSync(path.join(voltaHome, 'bin')) ? { VOLTA_HOME: voltaHome } : {}
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
  return { ...env, ...voltaHomeEnv(source), NO_COLOR: '1' }
}

/**
 * A HOME for grok runs that holds nothing but git identity.
 *
 * Grok reads Claude Code's configuration as its own — `~/.claude/skills`,
 * `~/.claude/agents`, `~/.claude/plugins`, `~/.claude.json` MCP servers,
 * `CLAUDE.md`, and `.claude/settings.json` permissions — and GROK_HOME does not
 * stop it. Neither do the GROK_CLAUDE_*_ENABLED switches: with all of them set
 * to 0 the operator's skills, agents and MCP servers still loaded. Since runs
 * spawn with permissions bypassed, that would hand an autonomous round the
 * operator's live MCP connections, and it puts uncontrolled variables into an
 * experiment built for controlled comparison.
 *
 * Pointing HOME somewhere empty does stop it, and leaves project-scoped
 * `.claude/agents/` discovery intact — verified. It lives under the temp dir so
 * a grok process can write there without touching the real home.
 *
 * Git is the one thing that legitimately wants the real home, and rounds record
 * revisions, so the user's git config is linked back in.
 */
export function neutralHome(): string {
  const home = path.join(os.tmpdir(), 'gauntlet-gamesmith-neutral-home')
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const link = path.join(home, '.gitconfig')
  const real = path.join(os.homedir(), '.gitconfig')
  try {
    if (!fs.existsSync(link) && fs.existsSync(real)) fs.symlinkSync(real, link)
  } catch {
    /* git falls back to repo-local config */
  }
  return home
}
