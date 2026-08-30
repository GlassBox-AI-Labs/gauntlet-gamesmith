import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { HarnessKind } from '../shared/harness'

export function cliHome(kind: HarnessKind): string {
  const home = path.join(app.getPath('userData'), 'harnesses', kind)
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.chmodSync(home, 0o700)
  return home
}

/** Directory for detached run transcripts and process metadata. */
export function runsDir(): string {
  const dir = path.join(app.getPath('userData'), 'runs')
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
