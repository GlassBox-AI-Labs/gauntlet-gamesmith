import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boundedOwnedDirectoryEntries, captureOwnedDirectory, readOwnedFile } from './owned-tree'
import { captureWorkspaceIdentity } from './workspace-boundary'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; owned: string; displaced: string; outside: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-owned-tree-'))
  roots.push(root)
  const owned = path.join(root, 'owned')
  const displaced = path.join(root, 'displaced')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(owned)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(owned, 'evidence.txt'), 'owned evidence')
  fs.writeFileSync(path.join(outside, 'evidence.txt'), 'outside secret')
  return { root, owned, displaced, outside }
}

describe('owned tree boundary', () => {
  it('rejects a workspace root replaced after its canonical identity was captured', () => {
    const { root } = fixture()
    const displaced = `${root}-displaced`
    roots.push(displaced)
    const expected = captureWorkspaceIdentity(root, [])
    fs.renameSync(root, displaced)
    fs.mkdirSync(root)

    expect(() => captureOwnedDirectory(root, root, expected)).toThrow(/changed identity/)
  })

  it('rejects a parent swapped between validation and directory enumeration', () => {
    const { root, owned, displaced, outside } = fixture()
    const boundary = captureOwnedDirectory(root, owned)
    const canonicalOwned = boundary.path
    const original = fs.opendirSync.bind(fs)
    let swapped = false
    vi.spyOn(fs, 'opendirSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
      if (!swapped && String(target) === canonicalOwned) {
        fs.renameSync(canonicalOwned, displaced)
        fs.symlinkSync(outside, canonicalOwned)
        swapped = true
      }
      return original(target, options as never)
    }) as typeof fs.opendirSync)

    expect(() => boundedOwnedDirectoryEntries(boundary, 10)).toThrow(/real directory|changed identity/)
  })

  it('rejects a parent swapped between validation and leaf open before reading it', () => {
    const { root, owned, displaced, outside } = fixture()
    const boundary = captureOwnedDirectory(root, owned)
    const canonicalOwned = boundary.path
    const original = fs.openSync.bind(fs)
    let swapped = false
    vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (!swapped && String(target) === path.join(canonicalOwned, 'evidence.txt')) {
        fs.renameSync(canonicalOwned, displaced)
        fs.symlinkSync(outside, canonicalOwned)
        swapped = true
      }
      return original(target, flags, mode)
    }) as typeof fs.openSync)

    expect(() => readOwnedFile(boundary, 'evidence.txt', 1_024)).toThrow(/real directory|changed identity/)
  })
})
