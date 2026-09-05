import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createContextFolders } from './context-folders'

const roots: string[] = []
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-folders-test-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
describe('context folder capabilities', () => {
  it('opens only a folder attached in this session and deduplicates it', () => {
    const root = fixture()
    const folders = createContextFolders()
    const folder = folders.add(root)!
    expect(folders.add(root)).toEqual(folder)
    expect(folders.resolve(folder.id)).toBe(fs.realpathSync(root))
    expect(() => folders.resolve(root)).toThrow('Attach this folder')
    expect(() => createContextFolders().resolve(folder.id)).toThrow('Attach this folder')
  })
  it('rejects malformed IPC values and distinguishes files without reading them', () => {
    const folders = createContextFolders()
    for (const value of [null, {}, 12, '../folder', 'file:///tmp', '/tmp/\0bad']) expect(() => folders.add(value)).toThrow()
    const file = path.join(fixture(), 'file.txt')
    fs.writeFileSync(file, 'context')
    expect(folders.add(file)).toBeNull()
  })
  it('rejects a folder replaced with a symlink before a Finder action', () => {
    const root = fixture()
    const original = path.join(root, 'original')
    const other = path.join(root, 'other')
    fs.mkdirSync(original)
    fs.mkdirSync(other)
    const folders = createContextFolders()
    const folder = folders.add(original)!
    fs.renameSync(original, path.join(root, 'moved'))
    fs.symlinkSync(other, original)
    expect(() => folders.resolve(folder.id)).toThrow('moved or changed')
  })
})
