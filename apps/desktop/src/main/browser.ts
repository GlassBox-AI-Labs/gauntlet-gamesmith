import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The one Chromium every agent gets.
 *
 * Playwright downloads browsers when the package is *installed*, never when one
 * is launched, so an install whose postinstall was skipped is permanently
 * broken and only says so the first time an agent calls `chromium.launch()`.
 * Left to improvise, agents installed Playwright into `/tmp` and then imported
 * whatever scratch directory a different run had left behind — one of them
 * pinned to a browser build that had never been fetched on this machine.
 *
 * So the app owns the cache. `PLAYWRIGHT_BROWSERS_PATH` points every child at
 * this one directory (see `harness-env.ts`), the app fills it before the phases
 * that need a browser, and the prompt rule tells agents not to go looking for
 * another. Because the variable is inherited, an agent that does install a
 * different Playwright version downloads its browser build into this same
 * cache instead of a temp directory nobody cleans up.
 */

/**
 * The Playwright the app downloads a browser for.
 *
 * Pinned so the cache has a known build in it rather than whatever the latest
 * release happens to be on the day of the first build.
 */
export const PLAYWRIGHT_VERSION = '1.57.0'

/** Written beside the browsers so a stale or half-deleted cache is cheap to spot. */
const STAMP = '.gauntlet-chromium'

/** Where the app keeps the shared cache, beside the other app-managed state. */
export function browsersDir(userDataDir: string): string {
  return path.join(userDataDir, 'playwright-browsers')
}

/**
 * Whether this version already downloaded a browser that is still there.
 *
 * Both halves matter: a stamp alone is what a cache looks like after someone
 * cleared their disk, and a browser alone may be a build some other Playwright
 * fetched, which is exactly the mismatch this module exists to end.
 */
export function chromiumReady(root: string): boolean {
  let stamp: string
  try {
    stamp = fs.readFileSync(path.join(root, STAMP), 'utf8').trim()
  } catch {
    return false
  }
  if (stamp !== PLAYWRIGHT_VERSION) return false
  try {
    return fs.readdirSync(root).some((entry) => entry.startsWith('chromium'))
  } catch {
    return false
  }
}

export interface BrowserInstall {
  /** The cache every child resolves its browsers through. */
  dir: string
  /** What happened, for the build log. */
  status: 'current' | 'installed' | 'unavailable'
  /** Why it is unavailable, in the installer's own words. */
  detail?: string
}

export type BrowserInstallRunner = (
  command: string,
  args: readonly string[],
  env: Record<string, string>,
) => Promise<{ code: number | null; output: string }>

/** Keeps a failure readable in the build log without pasting a whole npm run. */
const MAX_DETAIL_CHARS = 2000

/**
 * Download the pinned Chromium into `root` unless it is already there.
 *
 * Never throws. A machine without Node on `PATH` is a normal outcome — the
 * harness CLIs ship their own binaries and do not need it (ADR-014) — so a
 * failure is reported for the log and the build carries on. The agent then
 * falls back to installing Playwright itself, which now lands in this cache
 * rather than in a temp directory.
 */
export async function ensureChromium(root: string, run: BrowserInstallRunner = runInstaller): Promise<BrowserInstall> {
  if (chromiumReady(root)) return { dir: root, status: 'current' }
  try {
    fs.mkdirSync(root, { recursive: true })
    const { code, output } = await run(
      'npx',
      ['--yes', `playwright@${PLAYWRIGHT_VERSION}`, 'install', 'chromium'],
      { PLAYWRIGHT_BROWSERS_PATH: root },
    )
    if (code !== 0) return unavailable(root, output || `The installer exited with code ${code}.`)
    // A zero exit that downloaded nothing is the silent failure in the report:
    // trust the directory, not the status code.
    if (!fs.readdirSync(root).some((entry) => entry.startsWith('chromium'))) {
      return unavailable(root, output || 'The installer reported success but downloaded no browser.')
    }
    fs.writeFileSync(path.join(root, STAMP), `${PLAYWRIGHT_VERSION}\n`)
    return { dir: root, status: 'installed' }
  } catch (error) {
    return unavailable(root, error instanceof Error ? error.message : String(error))
  }
}

function unavailable(root: string, detail: string): BrowserInstall {
  try {
    fs.rmSync(path.join(root, STAMP), { force: true })
  } catch { /* a cache we cannot write to is already unavailable */ }
  return { dir: root, status: 'unavailable', detail: detail.trim().slice(-MAX_DETAIL_CHARS) }
}

/**
 * What the build log should say about an install, or nothing when a cache that
 * was already warm stayed warm.
 */
export function browserNotice(install: BrowserInstall): { channel: 'system' | 'error'; text: string } | null {
  if (install.status === 'current') return null
  if (install.status === 'installed') {
    return { channel: 'system', text: `Downloaded Chromium for Playwright ${PLAYWRIGHT_VERSION} into the app-managed browser cache.` }
  }
  return {
    channel: 'error',
    text: `Could not download Chromium into the app-managed browser cache: ${install.detail ?? 'the installer failed.'} Agents will have to install Playwright themselves, which downloads a browser into that same cache; nothing should reach for a temp directory.`,
  }
}

/** Merged rather than replaced: the installer needs the real PATH to find npx. */
const runInstaller: BrowserInstallRunner = (command, args, env) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const collect = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-MAX_DETAIL_CHARS) }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, output }))
})
