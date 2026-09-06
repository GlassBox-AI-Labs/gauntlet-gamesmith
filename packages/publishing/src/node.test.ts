import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, symlink, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { digest, packDirectory, validateArtifact } from './node'
import { assetPath, listing } from './index'
describe('artifact publication seam', () => {
  const file = (name: string, text = '<h1>Game</h1>') => ({ path: name, data: Buffer.from(text).toString('base64'), sha256: digest(text) })
  it('canonicalizes file order and verifies checksums', () => {
    const a = validateArtifact({ version: 1, sourceRevision: 'abc', files: [file('index.html'), file('app.js')] })
    const b = validateArtifact({ version: 1, sourceRevision: 'abc', files: [file('app.js'), file('index.html')] })
    expect(a.digest).toBe(b.digest)
    expect(() => validateArtifact({ ...a.artifact, files: [{ ...file('index.html'), data: 'eA==' }] })).toThrow('checksum')
  })
  it.each(['../index.html', '/index.html', 'a/../index.html', '.env', 'app.js.map', 'reference/art.png', 'a//b.js', 'a\\b.js', 'x.ts'])('rejects unsafe or nonshipping path %s', value => expect(() => assetPath(value)).toThrow())
  it('requires an entrypoint and rejects case-insensitive duplicates', () => {
    expect(() => validateArtifact({ version: 1, sourceRevision: 'abc', files: [file('app.js')] })).toThrow('index.html')
    expect(() => validateArtifact({ version: 1, sourceRevision: 'abc', files: [file('index.html'), file('INDEX.html')] })).toThrow('Duplicate')
  })
  it('packages only real files and fails on symlinks or private directories', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'catalog-pack-test-'))
    try {
      await writeFile(path.join(dir, 'index.html'), 'hello')
      expect((await packDirectory(dir, 'test')).files).toHaveLength(1)
      await symlink('/etc/passwd', path.join(dir, 'secret.txt'))
      await expect(packDirectory(dir, 'test')).rejects.toThrow('Linked')
      await rm(path.join(dir, 'secret.txt'))
      await mkdir(path.join(dir, '.gauntlet-gamesmith'))
      await expect(packDirectory(dir, 'test')).rejects.toThrow('Private')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('validates URL slugs and raster-only cover selection', () => {
    expect(() => listing({ title: 'Test', slug: 'bad/path', description: 'A game' })).toThrow()
    expect(() => listing({ title: 'Test', slug: 'test', description: 'A game', coverPath: 'cover.svg' })).toThrow('Cover')
  })
})
