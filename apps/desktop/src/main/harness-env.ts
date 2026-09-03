import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { HarnessKind } from '../shared/harness'
import { RUN_METADATA_DIR } from './run-transfer'
import { bundledSkillDir, installSkill, type SkillInstall } from './skills'

export function cliHome(kind: HarnessKind): string {
  const home = path.join(app.getPath('userData'), 'harnesses', kind)
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.chmodSync(home, 0o700)
  return home
}

/**
 * Put the vendored `img2threejs` skill where the Claude CLI will find it.
 *
 * The CLI discovers skills under whatever `CLAUDE_CONFIG_DIR` points at, and
 * every run is spawned with that set to `cliHome('claude')` — so this copies the
 * bundled skill into that home's `skills/`. Packaged, the source is the
 * `extraResources` copy under `resourcesPath`; in dev it is `vendor/` in the
 * repo.
 */
export function ensureSkill(): SkillInstall {
  return installSkill(cliHome('claude'), bundledSkillDir(app.isPackaged ? process.resourcesPath : null, __dirname))
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
