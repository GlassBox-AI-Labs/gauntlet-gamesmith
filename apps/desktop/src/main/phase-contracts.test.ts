import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { phaseTreeFingerprint, referencePackFingerprint } from './phase-contracts'

let dir: string | null = null
afterEach(() => {
  vi.restoreAllMocks()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('referencePackFingerprint', () => {
  it('is deterministic and detects a frozen-pack mutation at either phase boundary', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-pack-hash-'))
    dir = workspace
    const pack = path.join(workspace, 'reference', 'loop-1')
    fs.mkdirSync(pack, { recursive: true })
    fs.writeFileSync(path.join(pack, 'README.md'), 'frozen')
    const first = referencePackFingerprint(workspace, 'reference/loop-1')
    expect(referencePackFingerprint(workspace, 'reference/loop-1')).toBe(first)
    fs.writeFileSync(path.join(pack, 'README.md'), 'changed')
    expect(referencePackFingerprint(workspace, 'reference/loop-1')).not.toBe(first)
  })

  it('distinguishes a missing phase tree from a present tree and detects later writes', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-phase-hash-'))
    dir = workspace
    const missing = phaseTreeFingerprint(workspace, 'critique')
    fs.mkdirSync(path.join(workspace, 'critique'))
    const empty = phaseTreeFingerprint(workspace, 'critique')
    fs.writeFileSync(path.join(workspace, 'critique', 'evidence.txt'), 'new evidence')

    expect(empty).not.toBe(missing)
    expect(phaseTreeFingerprint(workspace, 'critique')).not.toBe(empty)
  })

  it('rejects a symlink planted at an optional phase-tree boundary', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-phase-hash-'))
    dir = workspace
    fs.symlinkSync('/tmp', path.join(workspace, 'critique'))
    expect(() => phaseTreeFingerprint(workspace, 'critique')).toThrow('symlink')
  })

  it('rejects symlinks rather than hashing files outside the pack', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-pack-hash-'))
    dir = workspace
    const pack = path.join(workspace, 'reference')
    fs.mkdirSync(pack)
    fs.symlinkSync('/etc/hosts', path.join(pack, 'hosts.txt'))
    expect(() => referencePackFingerprint(workspace, 'reference')).toThrow('symlink')
  })

  it('rejects hard-linked files rather than hashing content outside pack ownership', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-pack-hash-'))
    dir = workspace
    const pack = path.join(workspace, 'reference')
    fs.mkdirSync(pack)
    const outside = path.join(workspace, 'outside.txt')
    fs.writeFileSync(outside, 'not owned by the pack')
    fs.linkSync(outside, path.join(pack, 'linked.txt'))
    expect(() => referencePackFingerprint(workspace, 'reference')).toThrow('owned regular file')
  })

  it('rejects a pack root swapped after validation instead of traversing its replacement', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-pack-hash-'))
    dir = workspace
    const pack = path.join(workspace, 'reference')
    const canonicalPack = path.join(fs.realpathSync(workspace), 'reference')
    const originalPack = path.join(workspace, 'reference-original')
    fs.mkdirSync(pack)
    fs.writeFileSync(path.join(pack, 'README.md'), 'owned bytes')
    const originalOpenDirectory = fs.opendirSync.bind(fs)
    let swapped = false
    vi.spyOn(fs, 'opendirSync').mockImplementation(((target: fs.PathLike, options?: BufferEncoding | { encoding?: BufferEncoding; bufferSize?: number; recursive?: boolean }) => {
      if (!swapped && String(target) === canonicalPack) {
        swapped = true
        fs.renameSync(pack, originalPack)
        fs.mkdirSync(pack)
        fs.writeFileSync(path.join(pack, 'README.md'), 'replacement bytes')
      }
      return originalOpenDirectory(target, options as never)
    }) as typeof fs.opendirSync)

    expect(() => referencePackFingerprint(workspace, 'reference')).toThrow(/changed identity/)
    expect(fs.readFileSync(path.join(originalPack, 'README.md'), 'utf8')).toBe('owned bytes')
    expect(fs.readFileSync(path.join(pack, 'README.md'), 'utf8')).toBe('replacement bytes')
  })

  it('rejects a parent swapped between enumeration and a leaf open', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-pack-hash-'))
    dir = workspace
    const pack = path.join(workspace, 'reference')
    const originalPack = path.join(workspace, 'reference-original')
    fs.mkdirSync(pack)
    const leaf = path.join(pack, 'README.md')
    const canonicalLeaf = path.join(fs.realpathSync(workspace), 'reference', 'README.md')
    fs.writeFileSync(leaf, 'owned bytes')
    const originalOpen = fs.openSync.bind(fs)
    let swapped = false
    vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (!swapped && String(target) === canonicalLeaf) {
        swapped = true
        fs.renameSync(pack, originalPack)
        fs.mkdirSync(pack)
        fs.writeFileSync(leaf, 'replacement bytes')
      }
      return originalOpen(target, flags, mode)
    }) as typeof fs.openSync)

    expect(() => referencePackFingerprint(workspace, 'reference')).toThrow(/changed identity/)
    expect(fs.readFileSync(path.join(originalPack, 'README.md'), 'utf8')).toBe('owned bytes')
    expect(fs.readFileSync(leaf, 'utf8')).toBe('replacement bytes')
  })
})
