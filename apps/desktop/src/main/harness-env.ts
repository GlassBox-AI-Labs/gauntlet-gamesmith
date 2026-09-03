import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { HarnessKind } from '../shared/harness'
import { prepareAccountDir, readAccounts, sharedDir } from './accounts'
import { RUN_METADATA_DIR } from './run-transfer'

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
 * Keeping these out of the per-account credential dir is what lets a run
 * switch accounts between rounds and still `--continue` the same session.
 */
export function sharedHome(kind: HarnessKind): string {
  const shared = sharedDir(harnessesRoot(), kind)
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 })
  fs.chmodSync(shared, 0o700)
  return shared
}

/** Run transcripts live with the project so a folder transfer is complete. */
export function runsDir(workspaceDir: string): string {
  const dir = path.join(workspaceDir, RUN_METADATA_DIR, 'runs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function subscriptionEnv(overrides: Record<string, string>): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  delete env.ANTHROPIC_API_KEY
  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY
  return { ...env, ...overrides, NO_COLOR: '1' }
}
