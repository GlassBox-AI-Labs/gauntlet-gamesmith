import path from 'node:path'
import type { HarnessKind } from '../shared/harness'

/**
 * The vendors' own installer scripts. Both are native installers: they download
 * a platform binary and need no Node.js, which matters because the people who
 * most need this button are the ones least likely to have Node.
 *
 * Pinned as constants. Nothing user-supplied ever reaches the command line.
 */
export const INSTALL_SCRIPT_URLS: Record<HarnessKind, string> = {
  claude: 'https://claude.ai/install.sh',
  codex: 'https://chatgpt.com/codex/install.sh',
}

/**
 * Where both installers put the launcher. Claude's native installer manages
 * `~/.local/bin/claude`, and Codex's script defaults to `$HOME/.local/bin`.
 */
export const USER_BIN_DIR = path.join('.local', 'bin')

export interface InstallPlan {
  /** The shell that runs the piped installer, matching each vendor's docs. */
  command: string
  args: string[]
  /** Shown to the user before anything runs, so the action is never hidden. */
  displayCommand: string
  url: string
}

/**
 * The install command for a harness, or null where the app cannot run one.
 *
 * Windows is null on purpose: its documented installers are PowerShell and CMD
 * one-liners rather than a POSIX pipeline, and no Windows build ships yet, so
 * claiming support the app has not run would be worse than showing the command.
 */
export function installPlan(kind: HarnessKind, platform: NodeJS.Platform = process.platform): InstallPlan | null {
  if (platform !== 'darwin' && platform !== 'linux') return null
  const url = INSTALL_SCRIPT_URLS[kind]
  // Claude's installer documents bash; Codex's documents sh. Each is used as
  // published rather than normalized to one shell.
  const shell = kind === 'claude' ? 'bash' : 'sh'
  const pipeline = `curl -fsSL ${url} | ${shell}`
  return {
    command: '/bin/sh',
    args: ['-c', pipeline],
    displayCommand: pipeline,
    url,
  }
}

/**
 * The environment the installer runs in.
 *
 * This deliberately does not reuse the harness environment. That one rewrites
 * HOME to the app's private CLI home, and Codex's script reads CODEX_HOME and
 * CODEX_INSTALL_DIR — running it with those set would bury the binary inside
 * app-private state instead of installing it for the user. The installer gets
 * the real home and a plain PATH, and nothing else.
 */
export function installEnv(homeDir: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const systemPath = source.PATH ?? ''
  const required = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const entries = systemPath.split(path.delimiter).filter((entry) => entry.length > 0 && path.isAbsolute(entry))
  for (const directory of required) {
    if (!entries.includes(directory)) entries.push(directory)
  }
  return {
    HOME: homeDir,
    PATH: [...new Set(entries)].join(path.delimiter),
    // The scripts prompt when they want to edit a shell profile; answering no
    // is not possible from here, so run them in their non-interactive mode.
    CODEX_NON_INTERACTIVE: 'true',
    TERM: source.TERM ?? 'xterm-256color',
  }
}
