import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureRoundRevision, checkoutRoundRevision, cleanupRoundCheckout } from './round-revision'

const tempDirs: string[] = []

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
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\ndist\nscreenshots\n.gauntlet-loop\n')
    for (const excluded of ['node_modules', 'screenshots', 'dist']) {
      fs.mkdirSync(path.join(dir, excluded), { recursive: true })
      fs.writeFileSync(path.join(dir, excluded, 'ignored.txt'), excluded)
    }
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src', 'game.ts'), 'export const round = 1\n')

    const checkout = checkoutRoundRevision(dir, 1, captureRoundRevision({ workspaceDir: dir, loopId: 'loop-1', round: 1 }))

    expect(fs.readFileSync(path.join(checkout, 'src', 'game.ts'), 'utf8')).toContain('round = 1')
    expect(fs.existsSync(path.join(checkout, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(checkout, 'screenshots'))).toBe(false)
    expect(fs.existsSync(path.join(checkout, 'dist'))).toBe(false)
  })

  it('commits playable source while leaving telemetry and artifacts outside Git', () => {
    const dir = workspace()
    fs.mkdirSync(path.join(dir, 'src'))
    for (const excluded of ['node_modules', 'critique', 'reference', 'shots-r1', 'dist-r1']) {
      fs.mkdirSync(path.join(dir, excluded), { recursive: true })
      fs.writeFileSync(path.join(dir, excluded, 'ignored.txt'), excluded)
    }
    fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"dev":"vite"}}')
    fs.writeFileSync(path.join(dir, 'src', 'game.ts'), 'export const round = 1\n')

    const revision = captureRoundRevision({ workspaceDir: dir, loopId: 'loop-1', round: 1 })
    const checkout = checkoutRoundRevision(dir, 1, revision)

    expect(revision).toMatch(/^[0-9a-f]{40,64}$/)
    expect(fs.readFileSync(path.join(checkout, 'src', 'game.ts'), 'utf8')).toContain('round = 1')
    expect(fs.existsSync(path.join(checkout, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(checkout, 'critique'))).toBe(false)
    expect(fs.existsSync(path.join(checkout, 'reference'))).toBe(false)
    expect(fs.existsSync(path.join(checkout, 'shots-r1'))).toBe(false)
    expect(fs.existsSync(path.join(checkout, 'dist-r1'))).toBe(false)
    expect(fs.existsSync(path.join(dir, '.gauntlet-loop', 'revisions.git', 'objects'))).toBe(true)

    cleanupRoundCheckout(checkout)
    expect(fs.existsSync(checkout)).toBe(false)
  })

  it('chains later rounds from an explicit parent and can replay either revision', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'game.js'), 'round one')
    const first = captureRoundRevision({ workspaceDir: dir, loopId: 'loop-1', round: 1 })
    fs.writeFileSync(path.join(dir, 'game.js'), 'round two')
    const second = captureRoundRevision({ workspaceDir: dir, loopId: 'loop-1', round: 2, parentRevision: first })

    const firstCheckout = checkoutRoundRevision(dir, 1, first)
    expect(fs.readFileSync(path.join(firstCheckout, 'game.js'), 'utf8')).toBe('round one')
    cleanupRoundCheckout(firstCheckout)
    const secondCheckout = checkoutRoundRevision(dir, 2, second)
    expect(fs.readFileSync(path.join(secondCheckout, 'game.js'), 'utf8')).toBe('round two')
    expect(second).not.toBe(first)
  })
})
