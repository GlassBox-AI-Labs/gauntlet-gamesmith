import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { referencePackDir, scanReferencePack } from './reference-pack'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-reference-'))
  dirs.push(dir)
  return dir
}

describe('Reference Pack', () => {
  it('scopes each pack to its loop', () => {
    expect(referencePackDir('loop-123')).toBe('reference/loop-123')
    expect(() => referencePackDir('../elsewhere')).toThrow('Invalid loop id')
  })

  it('validates and inventories a completed pack', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    for (const subdir of ['images', 'motion', 'video']) fs.mkdirSync(path.join(dir, root, subdir), { recursive: true })
    for (let i = 0; i < 8; i += 1) {
      fs.writeFileSync(path.join(dir, root, 'images', `still-${i}.jpg`), 'image')
      fs.writeFileSync(path.join(dir, root, 'motion', `frame-${i}.png`), 'frame')
    }
    fs.writeFileSync(path.join(dir, root, 'video', 'gameplay.webm'), 'video')
    fs.writeFileSync(path.join(dir, root, 'README.md'), '# Target')
    fs.writeFileSync(path.join(dir, root, 'manifest.json'), JSON.stringify({ sources: [{ url: 'https://example.com' }] }))

    const pack = scanReferencePack(dir, root)
    expect(pack.ready).toBe(true)
    expect(pack.images).toHaveLength(8)
    expect(pack.motion).toHaveLength(8)
    expect(pack.videos).toHaveLength(1)
    expect(pack.readme).toContain('# Target')
  })

  it('returns actionable issues for an incomplete pack', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    fs.mkdirSync(path.join(dir, root), { recursive: true })
    fs.writeFileSync(path.join(dir, root, 'manifest.json'), '{bad json')

    const pack = scanReferencePack(dir, root)
    expect(pack.ready).toBe(false)
    expect(pack.issues).toContain('needs at least 8 stills (0 found)')
    expect(pack.issues).toContain('needs at least 8 motion frames (0 found)')
    expect(pack.issues).toContain('needs a gameplay video')
    expect(pack.issues).toContain('needs README.md with the target brief')
    expect(pack.issues).toContain('manifest.json is not valid JSON')
  })
})
