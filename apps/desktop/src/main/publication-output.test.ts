import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { trackPublicationOutput } from './publication-output'

const roots: string[] = []
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'publication-output-')),
  )
  roots.push(root)
  return root
}
async function write(root: string, file: string, data = '<html>game</html>') {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await fs.writeFile(path.join(root, file), data)
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true })
})
describe('automatic publication output', () => {
  it('finds a custom nested output and treats its nested pages as one build', async () => {
    const root = await fixture()
    await write(root, 'index.html', '<script src="/src/main.ts"></script>')
    await write(root, 'shipping/index.html')
    const logs: string[] = [],
      finish = await trackPublicationOutput(root, (text) => logs.push(text))
    await write(root, 'release/browser/index.html')
    await write(root, 'release/browser/help/index.html')
    expect(await finish()).toBe(path.join(root, 'release/browser'))
    expect(logs.join('\n')).toContain(
      'Detected shipping output: release/browser',
    )
  })
  it('recognizes an incremental build whose assets change while the HTML stays intact', async () => {
    const root = await fixture()
    await write(root, 'build/index.html')
    await write(root, 'build/app.js', 'old')
    const finish = await trackPublicationOutput(root, () => {})
    await write(root, 'build/app.js', 'updated game')
    expect(await finish()).toBe(path.join(root, 'build'))
  })
  it('does not select stale output or the source root after a no-op build', async () => {
    const root = await fixture()
    await write(root, 'dist/index.html')
    const finish = await trackPublicationOutput(root, () => {})
    await write(root, 'index.html')
    await expect(finish()).rejects.toThrow('could not be prepared')
  })
  it('rejects ambiguous outputs without selecting one arbitrarily', async () => {
    const root = await fixture(),
      logs: string[] = [],
      finish = await trackPublicationOutput(root, (text) => logs.push(text))
    await write(root, 'dist/index.html')
    await write(root, 'other-game/index.html')
    await expect(finish()).rejects.toThrow('could not be prepared')
    expect(logs.join('\n')).toContain('multiple generated browser outputs')
  })
  it('ignores private trees and does not follow linked outputs outside the saved round', async () => {
    const root = await fixture(),
      outside = await fixture(),
      finish = await trackPublicationOutput(root, () => {})
    await write(outside, 'index.html')
    await fs.symlink(outside, path.join(root, 'dist'))
    for (const dir of [
      '.private',
      'node_modules',
      'reference',
      'critique',
      'coverage',
    ])
      await write(root, `${dir}/index.html`)
    await expect(finish()).rejects.toThrow('could not be prepared')
  })
})
