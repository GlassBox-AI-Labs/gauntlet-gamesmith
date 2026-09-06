import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureRoundRevision,
  checkoutRoundRevision,
  cleanupRoundCheckout,
  configureRoundRevisionStorage,
  roundRevisionRepositoryPath,
  workspaceMatchesRevision,
} from './round-revision'
import { BUILD_METADATA_DIR } from './build-transfer'

const tempDirs: string[] = []
const LOOP_ID = '123e4567-e89b-42d3-a456-426614174000'
let revisionRoot = ''

beforeEach(() => {
  revisionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-private-revisions-'))
  tempDirs.push(revisionRoot)
  configureRoundRevisionStorage(revisionRoot)
})

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-round-revision-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('round revisions', () => {
  it('captures the round when the workspace .gitignore already ignores excluded folders', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\ndist\nscreenshots\n.gauntlet-gamesmith\n')
    for (const excluded of ['node_modules']) {
      fs.mkdirSync(path.join(dir, excluded), { recursive: true })
      fs.writeFileSync(path.join(dir, excluded, 'ignored.txt'), excluded)
    }
    for (const sourceOutput of ['screenshots', 'dist']) {
      fs.mkdirSync(path.join(dir, sourceOutput), { recursive: true })
      fs.writeFileSync(path.join(dir, sourceOutput, 'ignored.txt'), sourceOutput)
    }
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src', 'game.ts'), 'export const round = 1\n')

    const checkout = checkoutRoundRevision(dir, LOOP_ID, 1, captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 }))

    expect(fs.readFileSync(path.join(checkout, 'src', 'game.ts'), 'utf8')).toContain('round = 1')
    expect(fs.existsSync(path.join(checkout, 'node_modules'))).toBe(false)
    expect(fs.readFileSync(path.join(checkout, 'screenshots/ignored.txt'), 'utf8')).toBe('screenshots')
    expect(fs.readFileSync(path.join(checkout, 'dist/ignored.txt'), 'utf8')).toBe('dist')
  })

  it('commits playable source while leaving telemetry and artifacts outside Git', () => {
    const dir = workspace()
    fs.mkdirSync(path.join(dir, 'src'))
    for (const excluded of ['node_modules', 'critique', 'reference']) {
      fs.mkdirSync(path.join(dir, excluded), { recursive: true })
      fs.writeFileSync(path.join(dir, excluded, 'ignored.txt'), excluded)
    }
    for (const sourceOutput of ['shots-r1', 'dist-r1', 'build', 'nested/dist-assets', 'out']) {
      fs.mkdirSync(path.join(dir, sourceOutput), { recursive: true })
      fs.writeFileSync(path.join(dir, sourceOutput, 'source.txt'), sourceOutput)
    }
    fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"dev":"vite"}}')
    fs.writeFileSync(path.join(dir, 'src', 'game.ts'), 'export const round = 1\n')

    const revision = captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })
    const checkout = checkoutRoundRevision(dir, LOOP_ID, 1, revision)

    expect(revision).toMatch(/^[0-9a-f]{40,64}$/)
    expect(fs.readFileSync(path.join(checkout, 'src', 'game.ts'), 'utf8')).toContain('round = 1')
    expect(fs.existsSync(path.join(checkout, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(checkout, 'critique'))).toBe(false)
    expect(fs.existsSync(path.join(checkout, 'reference'))).toBe(false)
    for (const sourceOutput of ['shots-r1', 'dist-r1', 'build', 'nested/dist-assets', 'out']) {
      expect(fs.readFileSync(path.join(checkout, sourceOutput, 'source.txt'), 'utf8')).toBe(sourceOutput)
    }
    expect(fs.existsSync(path.join(roundRevisionRepositoryPath(LOOP_ID), 'objects'))).toBe(true)
    expect(fs.existsSync(path.join(dir, BUILD_METADATA_DIR, 'revisions.git'))).toBe(false)

    cleanupRoundCheckout(checkout)
    expect(fs.existsSync(checkout)).toBe(true)
  })

  it('chains later rounds from an explicit parent and can replay either revision', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'game.js'), 'round one')
    const first = captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })
    fs.writeFileSync(path.join(dir, 'game.js'), 'round two')
    const second = captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 2, parentRevision: first })

    const firstCheckout = checkoutRoundRevision(dir, LOOP_ID, 1, first)
    expect(fs.readFileSync(path.join(firstCheckout, 'game.js'), 'utf8')).toBe('round one')
    cleanupRoundCheckout(firstCheckout)
    const secondCheckout = checkoutRoundRevision(dir, LOOP_ID, 2, second)
    expect(fs.readFileSync(path.join(secondCheckout, 'game.js'), 'utf8')).toBe('round two')
    expect(second).not.toBe(first)
  })

  it('ignores an imported repository fsmonitor and hooks path', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'game.js'), 'safe')
    captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })
    const marker = path.join(dir, 'untrusted-config-ran')
    const command = path.join(dir, 'malicious-hook.sh')
    fs.writeFileSync(command, `#!/bin/sh\nprintf compromised > '${marker}'\n`)
    fs.chmodSync(command, 0o755)
    const repo = roundRevisionRepositoryPath(LOOP_ID)
    fs.appendFileSync(
      path.join(repo, 'config'),
      `\n[core]\n\tfsmonitor = ${command}\n\thooksPath = ${path.dirname(command)}\n`,
    )
    fs.writeFileSync(path.join(dir, 'game.js'), 'still safe')

    captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 2 })

    expect(fs.existsSync(marker)).toBe(false)
  })

  it('removes an app-repository clean filter before staging source', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'payload.txt'), 'first')
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'payload.txt filter=hostile\n')
    captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })
    const marker = path.join(dir, 'filter-ran')
    const command = path.join(dir, 'hostile-filter.sh')
    fs.writeFileSync(command, `#!/bin/sh\nprintf compromised > '${marker}'\ncat\n`)
    fs.chmodSync(command, 0o755)
    const config = path.join(roundRevisionRepositoryPath(LOOP_ID), 'config')
    fs.appendFileSync(config, `\n[filter "hostile"]\n\tclean = ${command}\n\trequired = true\n`)
    fs.writeFileSync(path.join(dir, 'payload.txt'), 'second')

    captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 2 })

    expect(fs.existsSync(marker)).toBe(false)
  })

  it.each(['objects symlink', 'refs symlink', 'config hardlink'] as const)('rejects a planted %s anywhere in the bare repository', (attack) => {
    const dir = workspace()
    const outside = workspace()
    fs.writeFileSync(path.join(dir, 'game.js'), 'first')
    captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })
    const repo = roundRevisionRepositoryPath(LOOP_ID)
    const sentinel = path.join(outside, 'sentinel')
    fs.writeFileSync(sentinel, 'untouched')
    if (attack === 'config hardlink') {
      fs.unlinkSync(path.join(repo, 'config'))
      fs.linkSync(sentinel, path.join(repo, 'config'))
    } else {
      const parent = attack.startsWith('objects') ? 'objects' : 'refs'
      fs.symlinkSync(outside, path.join(repo, parent, 'escape'))
    }
    fs.writeFileSync(path.join(dir, 'game.js'), 'second')

    expect(() => captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 2 })).toThrow(/symlink|non-owned/)
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('untouched')
  })

  it.each(['build-1', '../escape', 'space here', '/absolute', 'a'.repeat(129)])('rejects unsafe build id %s before creating a Git ref', (buildId) => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'game.js'), 'safe')
    expect(() => captureRoundRevision({ workspaceDir: dir, buildId, round: 1 })).toThrow(/Invalid build id/)
  })

  it('detects source drift while ignoring critic-owned evidence', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'game.js'), 'frozen')
    const revision = captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })
    expect(workspaceMatchesRevision(dir, LOOP_ID, revision)).toBe(true)
    fs.mkdirSync(path.join(dir, 'critique'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'critique', 'evidence.txt'), 'allowed')
    fs.writeFileSync(path.join(dir, 'gauntlet-report-v1.md'), 'runner-generated report')
    expect(workspaceMatchesRevision(dir, LOOP_ID, revision)).toBe(true)
    fs.writeFileSync(path.join(dir, 'game.js'), 'critic changed source')
    expect(workspaceMatchesRevision(dir, LOOP_ID, revision)).toBe(false)
  })

  it.each(['build/game.js', 'nested/dist-assets/game.js'])('detects critic mutation of playable output %s', (relative) => {
    const dir = workspace()
    const target = path.join(dir, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'frozen playable output')
    const revision = captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })

    fs.writeFileSync(target, 'critic changed playable output')

    expect(workspaceMatchesRevision(dir, LOOP_ID, revision)).toBe(false)
  })

  it('allows newly generated ignored build output but protects files captured under the same directory', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n')
    fs.mkdirSync(path.join(dir, 'src'))
    fs.mkdirSync(path.join(dir, 'dist'))
    fs.writeFileSync(path.join(dir, 'src', 'game.ts'), 'source')
    fs.writeFileSync(path.join(dir, 'dist', 'checked-in-runtime.js'), 'frozen playable output')
    const revision = captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })

    fs.writeFileSync(path.join(dir, 'dist', 'generated.js'), 'critic build output')
    expect(workspaceMatchesRevision(dir, LOOP_ID, revision)).toBe(true)

    fs.writeFileSync(path.join(dir, 'dist', 'checked-in-runtime.js'), 'critic changed captured output')
    expect(workspaceMatchesRevision(dir, LOOP_ID, revision)).toBe(false)
  })

  it('rejects a planted revision-repository symlink without changing its target', () => {
    const dir = workspace()
    const outside = workspace()
    fs.writeFileSync(path.join(outside, 'sentinel'), 'untouched')
    fs.mkdirSync(path.join(revisionRoot, LOOP_ID), { recursive: true })
    fs.symlinkSync(outside, path.join(revisionRoot, LOOP_ID, 'repository.git'))
    fs.writeFileSync(path.join(dir, 'game.js'), 'safe')

    expect(() => captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })).toThrow(/not a real directory/)
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('untouched')
  })

  it('never treats a workspace-planted revision repository as Git authority', () => {
    const dir = workspace()
    const outside = workspace()
    fs.writeFileSync(path.join(outside, 'sentinel'), 'untouched')
    fs.mkdirSync(path.join(dir, BUILD_METADATA_DIR), { recursive: true })
    fs.symlinkSync(outside, path.join(dir, BUILD_METADATA_DIR, 'revisions.git'))
    fs.writeFileSync(path.join(dir, 'game.js'), 'safe')

    const revision = captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })

    expect(revision).toMatch(/^[0-9a-f]{40,64}$/)
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('untouched')
    expect(roundRevisionRepositoryPath(LOOP_ID)).toContain(revisionRoot)
  })

  it('rejects a planted play-directory symlink before checkout', () => {
    const dir = workspace()
    const outside = workspace()
    fs.writeFileSync(path.join(dir, 'game.js'), 'safe')
    const revision = captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })
    fs.mkdirSync(path.join(dir, BUILD_METADATA_DIR), { recursive: true })
    fs.symlinkSync(outside, path.join(dir, BUILD_METADATA_DIR, 'play'))

    expect(() => checkoutRoundRevision(dir, LOOP_ID, 1, revision)).toThrow(/not a real directory/)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('uses a unique checkout and never deletes a replacement during cleanup', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'game.js'), 'saved revision')
    const revision = captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })
    const first = checkoutRoundRevision(dir, LOOP_ID, 1, revision)
    const second = checkoutRoundRevision(dir, LOOP_ID, 1, revision)
    expect(second).not.toBe(first)

    const original = `${first}-original`
    fs.renameSync(first, original)
    fs.mkdirSync(first)
    fs.writeFileSync(path.join(first, 'operator.txt'), 'preserve me')

    expect(() => cleanupRoundCheckout(first)).toThrow(/unowned round checkout/)
    expect(fs.readFileSync(path.join(first, 'operator.txt'), 'utf8')).toBe('preserve me')
    expect(fs.readFileSync(path.join(original, 'game.js'), 'utf8')).toBe('saved revision')
  })

  it('bounds retained unique checkouts instead of deleting an uncertain path', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'game.js'), 'saved revision')
    const revision = captureRoundRevision({ workspaceDir: dir, buildId: LOOP_ID, round: 1 })
    const playRoot = path.join(dir, BUILD_METADATA_DIR, 'play')
    fs.mkdirSync(playRoot, { recursive: true })
    for (let index = 0; index < 16; index += 1) {
      fs.mkdirSync(path.join(playRoot, `round-1-${revision.slice(0, 12)}-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`))
    }

    expect(() => checkoutRoundRevision(dir, LOOP_ID, 1, revision)).toThrow(/16-checkout limit.*Remove retained directories/)
    expect(fs.readdirSync(playRoot)).toHaveLength(16)
  })
})
