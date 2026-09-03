import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OWNED_WORKSPACE_FILE_MARKER,
  OWNED_YAML_FILE_MARKER,
  publishOwnedWorkspaceFile,
  publishOwnedWorkspaceSnapshot,
} from './owned-workspace-write'

const roots: string[] = []

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-owned-write-'))
  roots.push(root)
  return root
}

function registered(root: string): { dev: number; ino: number } {
  const stat = fs.lstatSync(root)
  return { dev: stat.dev, ino: stat.ino }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('immutable owned workspace publication', () => {
  it('creates an exact publication and reuses only the same bytes', () => {
    const root = workspace()
    const identity = registered(root)
    const target = publishOwnedWorkspaceFile(root, identity, ['.claude', 'agents'], 'implementer-a.md', 'first')
    expect(publishOwnedWorkspaceFile(root, identity, ['.claude', 'agents'], 'implementer-a.md', 'first')).toBe(target)
    expect(fs.readFileSync(target, 'utf8')).toBe(`${OWNED_WORKSPACE_FILE_MARKER}first`)

    expect(() => publishOwnedWorkspaceFile(root, identity, ['.claude', 'agents'], 'implementer-a.md', 'second')).toThrow(/immutable publication|Refusing to replace/)
    expect(fs.readFileSync(target, 'utf8')).toBe(`${OWNED_WORKSPACE_FILE_MARKER}first`)
  })

  it('does not clobber an ordinary unmarked file at a publication name', () => {
    const root = workspace()
    const target = path.join(root, 'report.md')
    fs.writeFileSync(target, 'operator-authored report')

    expect(() => publishOwnedWorkspaceFile(root, registered(root), [], 'report.md', 'generated')).toThrow(/immutable publication|Refusing to replace/)
    expect(fs.readFileSync(target, 'utf8')).toBe('operator-authored report')
  })

  it('keeps Claude agent YAML frontmatter at byte zero while marking ownership', () => {
    const root = workspace()
    const target = publishOwnedWorkspaceFile(root, registered(root), ['.claude', 'agents'], 'implementer-a.md', '---\nname: implementer\n---\nBody\n', 'yaml-frontmatter')

    expect(fs.readFileSync(target, 'utf8')).toBe(`---\n${OWNED_YAML_FILE_MARKER}name: implementer\n---\nBody\n`)
  })

  it('rejects planted parent and final links without touching their targets', () => {
    const root = workspace()
    const outside = workspace()
    fs.symlinkSync(outside, path.join(root, '.claude'))
    expect(() => publishOwnedWorkspaceFile(root, registered(root), ['.claude', 'agents'], 'implementer-a.md', 'unsafe')).toThrow('not a real directory')
    expect(fs.readdirSync(outside)).toEqual([])

    for (const kind of ['symlink', 'hardlink'] as const) {
      const linkedRoot = workspace()
      const source = path.join(linkedRoot, `${kind}-source.txt`)
      const target = path.join(linkedRoot, 'report.md')
      fs.writeFileSync(source, 'operator data')
      if (kind === 'symlink') fs.symlinkSync(source, target)
      else fs.linkSync(source, target)
      expect(() => publishOwnedWorkspaceFile(linkedRoot, registered(linkedRoot), [], 'report.md', 'unsafe')).toThrow(/immutable publication/)
      expect(fs.readFileSync(source, 'utf8')).toBe('operator data')
    }
  })

  it('preserves a target planted at the exclusive-create boundary', () => {
    const root = workspace()
    const target = path.join(root, 'report-a.md')
    const originalOpenDirectory = fs.opendirSync.bind(fs)
    let planted = false
    vi.spyOn(fs, 'opendirSync').mockImplementation(((directory: fs.PathLike, options?: BufferEncoding | { encoding?: BufferEncoding; bufferSize?: number; recursive?: boolean }) => {
      if (!planted) {
        planted = true
        fs.writeFileSync(target, 'racing operator bytes')
      }
      return originalOpenDirectory(directory, options as never)
    }) as typeof fs.opendirSync)

    expect(() => publishOwnedWorkspaceFile(root, registered(root), [], 'report-a.md', 'generated', 'html', {
      managedPrefix: 'report-',
      maxFiles: 8,
      maxBytes: 1024,
    })).toThrow(/EEXIST|immutable publication|Refusing to replace/)
    expect(fs.readFileSync(target, 'utf8')).toBe('racing operator bytes')
  })

  it('never renames or unlinks racing temporary and previous entries', () => {
    const root = workspace()
    const temporary = path.join(root, '.report-a.md.race.tmp')
    const previous = path.join(root, '.report-a.md.race.previous')
    fs.writeFileSync(temporary, 'operator temporary bytes')
    fs.writeFileSync(previous, 'operator recovery bytes')
    const rename = vi.spyOn(fs, 'renameSync')
    const unlink = vi.spyOn(fs, 'unlinkSync')

    publishOwnedWorkspaceFile(root, registered(root), [], 'report-a.md', 'generated')

    expect(rename).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
    expect(fs.readFileSync(temporary, 'utf8')).toBe('operator temporary bytes')
    expect(fs.readFileSync(previous, 'utf8')).toBe('operator recovery bytes')
  })

  it('leaves an uncertain partial publication for inspection instead of unlinking it', () => {
    const root = workspace()
    const target = path.join(root, 'report-a.md')
    const originalWrite = fs.writeFileSync.bind(fs)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
      if (typeof file === 'number') {
        originalWrite(file, Buffer.from('partial'))
        throw new Error('synthetic write failure')
      }
      return originalWrite(file, data)
    }) as typeof fs.writeFileSync)

    expect(() => publishOwnedWorkspaceFile(root, registered(root), [], 'report-a.md', 'generated')).toThrow('synthetic write failure')
    expect(fs.readFileSync(target, 'utf8')).toBe('partial')
  })

  it('bounds retained content-addressed generations without deleting them', () => {
    const root = workspace()
    const limits = { managedPrefix: 'snapshot-', maxFiles: 2, maxBytes: 1024 }
    const identity = registered(root)
    const first = publishOwnedWorkspaceSnapshot(root, identity, ['snapshots'], 'snapshot', '.md', 'one', 'html', limits)
    const second = publishOwnedWorkspaceSnapshot(root, identity, ['snapshots'], 'snapshot', '.md', 'two', 'html', limits)
    expect(() => publishOwnedWorkspaceSnapshot(root, identity, ['snapshots'], 'snapshot', '.md', 'three', 'html', limits)).toThrow(/retention limit/)
    expect(fs.readFileSync(first, 'utf8')).toContain('one')
    expect(fs.readFileSync(second, 'utf8')).toContain('two')
  })

  it('rejects a workspace root replaced after directory validation', () => {
    const root = workspace()
    const replacement = workspace()
    const identity = registered(root)
    const preserved = `${root}-preserved`
    roots.push(preserved)
    const originalOpenDirectory = fs.opendirSync.bind(fs)
    let swapped = false
    vi.spyOn(fs, 'opendirSync').mockImplementation(((directory: fs.PathLike, options?: BufferEncoding | { encoding?: BufferEncoding; bufferSize?: number; recursive?: boolean }) => {
      if (!swapped) {
        swapped = true
        fs.renameSync(root, preserved)
        fs.symlinkSync(replacement, root)
      }
      return originalOpenDirectory(directory, options as never)
    }) as typeof fs.opendirSync)

    expect(() => publishOwnedWorkspaceFile(root, identity, [], 'report-a.md', 'generated', 'html', {
      managedPrefix: 'report-',
      maxFiles: 8,
      maxBytes: 1024,
    })).toThrow(/Workspace root changed identity/)
    expect(fs.existsSync(path.join(replacement, 'report-a.md'))).toBe(false)
  })
})
