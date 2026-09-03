import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { HarnessKind } from '../shared/harness'
import { RUN_METADATA_DIR } from './run-transfer'

export function cliHome(kind: HarnessKind): string {
  const home = path.join(app.getPath('userData'), 'harnesses', kind)
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.chmodSync(home, 0o700)
  return home
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
