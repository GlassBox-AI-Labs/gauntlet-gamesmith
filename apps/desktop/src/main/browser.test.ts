import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PLAYWRIGHT_VERSION, browserNotice, browsersDir, chromiumReady, ensureChromium } from './browser'

const roots: string[] = []

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gauntlet-browser-'))
  roots.push(dir)
  return dir
}

/** A cache the way `playwright install chromium` leaves one. */
function seedChromium(root: string): void {
  fs.mkdirSync(path.join(root, 'chromium-1234'), { recursive: true })
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

it('keeps the browser cache inside the app data directory', () => {
  expect(browsersDir('/data')).toBe(path.join('/data', 'playwright-browsers'))
})

describe('chromiumReady', () => {
  it('is false with no cache at all', () => {
    expect(chromiumReady(path.join(tempRoot(), 'missing'))).toBe(false)
  })

  it('is false when the stamp is there but the browser was deleted underneath it', () => {
    const root = tempRoot()
    fs.writeFileSync(path.join(root, '.gauntlet-chromium'), `${PLAYWRIGHT_VERSION}\n`)
    expect(chromiumReady(root)).toBe(false)
  })

  it('is false when a browser is present but another Playwright version put it there', () => {
    const root = tempRoot()
    seedChromium(root)
    fs.writeFileSync(path.join(root, '.gauntlet-chromium'), '0.0.1\n')
    expect(chromiumReady(root)).toBe(false)
  })

  it('is true only when this version stamped a cache that still holds a browser', () => {
    const root = tempRoot()
    seedChromium(root)
    fs.writeFileSync(path.join(root, '.gauntlet-chromium'), `${PLAYWRIGHT_VERSION}\n`)
    expect(chromiumReady(root)).toBe(true)
  })
})

describe('ensureChromium', () => {
  it('downloads the pinned browser into the cache and stamps it', async () => {
    const root = path.join(tempRoot(), 'browsers')
    const calls: { command: string; args: readonly string[]; env: Record<string, string> }[] = []
    const install = await ensureChromium(root, async (command, args, env) => {
      calls.push({ command, args, env })
      seedChromium(root)
      return { code: 0, output: 'downloaded' }
    })

    expect(install).toEqual({ dir: root, status: 'installed' })
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('npx')
    expect(calls[0].args).toEqual(['--yes', `playwright@${PLAYWRIGHT_VERSION}`, 'install', 'chromium'])
    expect(calls[0].env.PLAYWRIGHT_BROWSERS_PATH).toBe(root)
    expect(chromiumReady(root)).toBe(true)
  })

  it('does not download again once the cache is stamped', async () => {
    const root = tempRoot()
    seedChromium(root)
    fs.writeFileSync(path.join(root, '.gauntlet-chromium'), `${PLAYWRIGHT_VERSION}\n`)

    let ran = false
    const install = await ensureChromium(root, async () => {
      ran = true
      return { code: 0, output: '' }
    })

    expect(install).toEqual({ dir: root, status: 'current' })
    expect(ran).toBe(false)
  })

  it('reports the installer output when the download fails, and leaves no stamp', async () => {
    const root = tempRoot()
    const install = await ensureChromium(root, async () => ({ code: 1, output: 'npx: command not found' }))

    expect(install.status).toBe('unavailable')
    expect(install.detail).toContain('npx: command not found')
    expect(chromiumReady(root)).toBe(false)
  })

  it('treats a silent success that produced no browser as a failure', async () => {
    const root = tempRoot()
    const install = await ensureChromium(root, async () => ({ code: 0, output: 'nothing to do' }))

    expect(install.status).toBe('unavailable')
    expect(chromiumReady(root)).toBe(false)
  })

  it('reports a runner that could not start at all', async () => {
    const root = tempRoot()
    const install = await ensureChromium(root, async () => { throw new Error('spawn ENOENT') })

    expect(install.status).toBe('unavailable')
    expect(install.detail).toContain('spawn ENOENT')
  })
})

describe('browserNotice', () => {
  it('says nothing when a warm cache stayed warm', () => {
    expect(browserNotice({ dir: '/cache', status: 'current' })).toBeNull()
  })

  it('reports a download as ordinary progress', () => {
    const notice = browserNotice({ dir: '/cache', status: 'installed' })
    expect(notice?.channel).toBe('system')
    expect(notice?.text).toContain(PLAYWRIGHT_VERSION)
  })

  it('reports a failed download as an error that names the cause', () => {
    const notice = browserNotice({ dir: '/cache', status: 'unavailable', detail: 'npx: command not found' })
    expect(notice?.channel).toBe('error')
    expect(notice?.text).toContain('npx: command not found')
  })

  it('still reports a failure that arrived with no detail', () => {
    const notice = browserNotice({ dir: '/cache', status: 'unavailable' })
    expect(notice?.channel).toBe('error')
    expect(notice?.text).toContain('the installer failed')
  })
})
