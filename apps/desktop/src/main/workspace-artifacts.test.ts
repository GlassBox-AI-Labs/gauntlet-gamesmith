import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listArtifactLocations, listGameAssetGallery, parseArtifactLocationKind, resolveArtifactLocation } from './workspace-artifacts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('workspace artifact locations', () => {
  it('lists fixed browse targets and counts only their immediate real entries', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'))
    roots.push(workspace)
    fs.mkdirSync(path.join(workspace, 'src', 'assets'), { recursive: true })
    fs.writeFileSync(path.join(workspace, 'src', 'assets', 'hero.ts'), 'export {}')
    fs.mkdirSync(path.join(workspace, '.img2threejs', 'hero'), { recursive: true })

    const rows = listArtifactLocations(workspace, 'loop-1')
    expect(rows.find((row) => row.kind === 'assets')).toMatchObject({ exists: true, itemCount: 1, relativePath: path.join('src', 'assets') })
    expect(rows.find((row) => row.kind === 'sculpt-evidence')).toMatchObject({ exists: true, itemCount: 1 })
    expect(rows.find((row) => row.kind === 'critique')).toMatchObject({ exists: false, itemCount: 0 })
  })

  it('rejects unknown targets and nested symlink escapes', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-outside-'))
    roots.push(workspace, outside)
    fs.mkdirSync(path.join(workspace, 'src'))
    fs.symlinkSync(outside, path.join(workspace, 'src', 'assets'))

    expect(resolveArtifactLocation(workspace, 'loop-1', 'assets')).toBeNull()
    expect(() => parseArtifactLocationKind('../outside')).toThrow(/Unknown artifact/)
  })

  it('builds a bounded visual gallery from factories and real sculptor previews', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'))
    roots.push(workspace)
    fs.mkdirSync(path.join(workspace, 'src', 'assets'), { recursive: true })
    fs.writeFileSync(path.join(workspace, 'src', 'assets', 'crystal-maiden.ts'), 'export {}')
    fs.writeFileSync(path.join(workspace, 'src', 'assets', 'pools.ts'), 'export {}')
    fs.writeFileSync(path.join(workspace, 'src', 'assets', 'sculpt-types.ts'), 'export {}')
    fs.mkdirSync(path.join(workspace, '.img2threejs', 'crystal-maiden'), { recursive: true })
    fs.writeFileSync(path.join(workspace, '.img2threejs', 'crystal-maiden', 'preview.png'), 'image')
    fs.writeFileSync(path.join(workspace, '.img2threejs', 'crystal-maiden', 'spec.md'), 'evidence')

    expect(listGameAssetGallery(workspace, 'loop-1')).toEqual([
      {
        slug: 'crystal-maiden',
        label: 'Crystal Maiden',
        factoryPath: 'src/assets/crystal-maiden.ts',
        evidencePath: '.img2threejs/crystal-maiden',
        previewPath: '.img2threejs/crystal-maiden/preview.png',
        evidenceCount: 2,
      },
      {
        slug: 'pools',
        label: 'Pools',
        factoryPath: 'src/assets/pools.ts',
        evidencePath: null,
        previewPath: null,
        evidenceCount: 0,
      },
    ])
  })

  it('does not expose preview files through a symlinked sculptor directory', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-outside-'))
    roots.push(workspace, outside)
    fs.mkdirSync(path.join(workspace, 'src', 'assets'), { recursive: true })
    fs.writeFileSync(path.join(workspace, 'src', 'assets', 'hero.ts'), 'export {}')
    fs.mkdirSync(path.join(workspace, '.img2threejs'))
    fs.writeFileSync(path.join(outside, 'preview.png'), 'secret')
    fs.symlinkSync(outside, path.join(workspace, '.img2threejs', 'hero'))

    expect(listGameAssetGallery(workspace, 'loop-1')[0]).toMatchObject({
      slug: 'hero',
      evidencePath: null,
      previewPath: null,
    })
  })
})
