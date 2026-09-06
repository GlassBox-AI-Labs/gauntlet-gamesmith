import fs from 'node:fs'
import path from 'node:path'

/**
 * Getting the vendored `img2threejs` skill from the app bundle into the place
 * the Claude CLI will actually look for it.
 *
 * The skill has to exist as real files: the sculptor runs `forge/state.py` and
 * `forge/next.py` with Python, so it cannot live inside the asar. It ships as an
 * `extraResources` entry (see the `build` block in package.json) and is copied
 * into the harness home before the first Asset Build.
 *
 * This exists because a missing skill fails silently and expensively. The
 * sculptor brief says "using the `img2threejs` skill" and then calls
 * `forge/state.py`; with nothing to load, the agent cannot run the pipeline, so
 * it hand-writes a model shaped like the skill's output instead — 18,531 lines
 * of it across the three builds in `docs/ASSET-PHASE.md`, with zero `Skill` calls
 * behind them. Nothing downstream could tell the difference.
 */

export const SKILL_NAME = 'img2threejs'

/** Copied beside the installed skill so a stale copy can be spotted cheaply. */
const STAMP = '.gauntlet-source'

/**
 * Where the vendored skill sits, packaged or not.
 *
 * Packaged, electron-builder puts `extraResources` under `resourcesPath`. In
 * dev there is no such directory, so walk up from the compiled main bundle to
 * the repo root — `out/main/` in the app, `src/main/` under vitest, both of
 * which reach `vendor/` by climbing until it appears.
 */
export function bundledSkillDir(resourcesPath: string | null, fromDir: string): string | null {
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'vendor', SKILL_NAME)
    if (fs.existsSync(packaged)) return packaged
  }
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'vendor', SKILL_NAME)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The marker every complete install has, and the cheapest proof of one. */
function isUsable(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'SKILL.md')) && fs.existsSync(path.join(dir, 'forge', 'state.py'))
}

export interface SkillInstall {
  /** Where the CLI will find it, or null when there was nothing to install. */
  dir: string | null
  /** What happened, for the build log. */
  status: 'installed' | 'replaced' | 'current' | 'missing-source'
}

/**
 * Put the bundled skill under `<claudeHome>/skills/<name>`, replacing whatever
 * is there unless it is already a copy of this exact source.
 *
 * The app owns that path now. A hand-made symlink or an older copy is replaced
 * rather than trusted: the version that ships is the version the sculptor brief
 * was written against, and an attempt that silently used a different one is the bug
 * this whole module is here to prevent.
 */
export function installSkill(claudeHome: string, sourceDir: string | null): SkillInstall {
  if (!sourceDir || !isUsable(sourceDir)) return { dir: null, status: 'missing-source' }
  const target = path.join(claudeHome, 'skills', SKILL_NAME)
  // realpath, so an install through a symlinked home still matches its stamp.
  const stamp = fs.realpathSync(sourceDir)
  const existing = fs.existsSync(path.join(target, STAMP)) ? fs.readFileSync(path.join(target, STAMP), 'utf8').trim() : null
  if (existing === stamp && isUsable(target)) return { dir: target, status: 'current' }
  const had = fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false }) != null
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  // Dereference: the source may itself be a symlink into a checkout, and a
  // symlinked skill is exactly the fragile setup this replaces.
  fs.cpSync(sourceDir, target, { recursive: true, dereference: true })
  fs.writeFileSync(path.join(target, STAMP), `${stamp}\n`)
  return { dir: target, status: had ? 'replaced' : 'installed' }
}
