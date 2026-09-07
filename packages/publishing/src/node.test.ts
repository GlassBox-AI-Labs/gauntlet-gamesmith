import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, symlink, mkdir, rm } from 'node:fs/promises'
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
  it('preserves Markdown license notices byte-for-byte in hosted-compatible text assets', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'catalog-license-test-'))
    const notice = Buffer.from('# Asset licenses\r\nKenney — CC0\r\n')
    const events: string[] = []
    try {
      await writeFile(path.join(dir, 'index.html'), 'game')
      await writeFile(path.join(dir, 'ASSET-LICENSES.md'), notice)
      await mkdir(path.join(dir, 'assets'))
      await writeFile(path.join(dir, 'assets', 'License.MD'), notice)
      const artifact = await packDirectory(dir, 'saved-round', text => events.push(text))
      expect(artifact.files.map(f => f.path)).toEqual(['ASSET-LICENSES.txt', 'assets/License.txt', 'index.html'])
      for (const f of artifact.files.filter(f => f.path.endsWith('.txt'))) {
        expect(Buffer.from(f.data, 'base64')).toEqual(notice)
        expect(f.sha256).toBe(digest(notice))
      }
      expect(await readFile(path.join(dir, 'ASSET-LICENSES.md'))).toEqual(notice)
      expect(events).toContain('Preserving license notice ASSET-LICENSES.md as ASSET-LICENSES.txt in the upload; contents are unchanged.')
      expect(validateArtifact(artifact).artifact).toEqual(artifact)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects license destination collisions instead of losing either notice', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'catalog-license-collision-'))
    try {
      await writeFile(path.join(dir, 'index.html'), 'game')
      await writeFile(path.join(dir, 'LICENSE.md'), 'first notice')
      await writeFile(path.join(dir, 'license.txt'), 'second notice')
      await expect(packDirectory(dir, 'saved-round')).rejects.toThrow('Duplicate asset path')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('still rejects arbitrary Markdown and linked license files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'catalog-license-unsafe-'))
    try {
      await writeFile(path.join(dir, 'index.html'), 'game')
      await writeFile(path.join(dir, 'private-notes.md'), 'not for publication')
      await expect(packDirectory(dir, 'saved-round')).rejects.toThrow('Unsupported asset path')
      await rm(path.join(dir, 'private-notes.md'))
      await symlink(path.join(dir, 'index.html'), path.join(dir, 'LICENSE.md'))
      await expect(packDirectory(dir, 'saved-round')).rejects.toThrow('Linked build entry')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('leaves source maps out of the upload instead of failing the whole artifact', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'catalog-sourcemap-'))
    try {
      await writeFile(path.join(dir, 'index.html'), 'game')
      await mkdir(path.join(dir, 'assets'))
      await writeFile(path.join(dir, 'assets', 'index-abc.js'), 'console.log(1)')
      // Vite writes this whenever build.sourcemap is on. One of them used to
      // reject the entire publication as an unsupported asset path.
      await writeFile(path.join(dir, 'assets', 'index-abc.js.map'), '{"version":3}')
      const lines: string[] = []
      const artifact = await packDirectory(dir, 'saved-round', (text) => lines.push(text))
      expect(artifact.files.map((file) => file.path).sort()).toEqual(['assets/index-abc.js', 'index.html'])
      // The operator is told what was dropped rather than silently losing files.
      expect(lines.join('\n')).toContain('assets/index-abc.js.map')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('still rejects an unsupported file type that is not a source map', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'catalog-unsupported-'))
    try {
      await writeFile(path.join(dir, 'index.html'), 'game')
      await writeFile(path.join(dir, 'game.exe'), 'binary')
      await expect(packDirectory(dir, 'saved-round')).rejects.toThrow('Unsupported asset path')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
