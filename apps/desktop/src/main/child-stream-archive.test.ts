import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentsDir } from './child-agents'
import { archiveChildStreams } from './child-stream-archive'

let dir: string | null = null
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('archiveChildStreams', () => {
  it('treats a never-created agent directory as an empty archive', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-archive-empty-'))

    expect(archiveChildStreams(dir, randomUUID())).toBe(0)
    expect(fs.existsSync(agentsDir(dir))).toBe(false)
  })

  it('preserves valid prior streams under the owning build', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-archive-'))
    const root = agentsDir(dir)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'gameplay.codex.jsonl'), 'evidence')

    const attemptId = randomUUID()
    expect(archiveChildStreams(dir, attemptId)).toBe(1)
    const archived = fs.readdirSync(path.join(root, attemptId))
    expect(archived).toHaveLength(2)
    const projected = archived.find((name) => name.endsWith('.archived'))!
    expect(projected).toMatch(/^gameplay\.codex\.jsonl\..+\.archived$/)
    expect(fs.readFileSync(path.join(root, attemptId, projected), 'utf8')).toBe('evidence')
  })

  it('rejects planted non-stream metadata before moving evidence', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-archive-planted-'))
    const root = agentsDir(dir)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'gameplay.codex.jsonl'), 'evidence')
    fs.writeFileSync(path.join(root, 'notes.txt'), 'planted')

    const attemptId = randomUUID()
    expect(() => archiveChildStreams(dir!, attemptId)).toThrow(/Unexpected entry/)
    expect(fs.readFileSync(path.join(root, 'gameplay.codex.jsonl'), 'utf8')).toBe('evidence')
    expect(fs.existsSync(path.join(root, attemptId))).toBe(false)
  })

  it('refuses an archive destination symlink', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-archive-'))
    const root = agentsDir(dir)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-archive-outside-'))
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'gameplay.codex.jsonl'), 'evidence')
    const attemptId = randomUUID()
    fs.symlinkSync(outside, path.join(root, attemptId))
    try {
      expect(() => archiveChildStreams(dir!, attemptId)).toThrow(/Unexpected entry|archive destination must be a real directory/)
      expect(fs.readdirSync(outside)).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('fails before moving anything when valid streams exceed the archive limit', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-archive-capped-'))
    const root = agentsDir(dir)
    fs.mkdirSync(root, { recursive: true })
    for (let index = 0; index < 257; index += 1) {
      fs.writeFileSync(path.join(root, `worker-${String(index).padStart(3, '0')}.codex.jsonl`), 'evidence')
    }

    const attemptId = randomUUID()
    expect(() => archiveChildStreams(dir!, attemptId)).toThrow(/bounded inventory/)
    expect(fs.existsSync(path.join(root, attemptId))).toBe(false)
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.jsonl'))).toHaveLength(257)
  })

  it('does not archive a hard link to a file outside the agent directory', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-archive-hardlink-'))
    const root = agentsDir(dir)
    fs.mkdirSync(root, { recursive: true })
    const outside = path.join(dir, 'outside')
    fs.writeFileSync(outside, 'not owned evidence')
    fs.linkSync(outside, path.join(root, 'gameplay.codex.jsonl'))

    expect(() => archiveChildStreams(dir!, randomUUID())).toThrow(/singly linked regular file|unlinked regular file/)
    expect(fs.readFileSync(outside, 'utf8')).toBe('not owned evidence')
  })

  it('preserves a preplanted canonical archive file while moving new evidence to a unique path', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-archive-collision-'))
    const root = agentsDir(dir)
    const attemptId = randomUUID()
    const archive = path.join(root, attemptId)
    fs.mkdirSync(archive, { recursive: true })
    fs.writeFileSync(path.join(root, 'gameplay.codex.jsonl'), 'actual evidence')
    fs.writeFileSync(path.join(archive, 'gameplay.codex.jsonl'), 'planted evidence')

    expect(archiveChildStreams(dir!, attemptId)).toBe(1)
    expect(fs.readFileSync(path.join(archive, 'gameplay.codex.jsonl'), 'utf8')).toBe('planted evidence')
    const unique = fs.readdirSync(archive).find((name) => name.endsWith('.archived'))!
    expect(fs.readFileSync(path.join(archive, unique), 'utf8')).toBe('actual evidence')
  })

  it('never deletes a replacement moved by a source-path race', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-archive-race-'))
    const root = agentsDir(dir)
    const attemptId = randomUUID()
    fs.mkdirSync(root, { recursive: true })
    const source = path.join(root, 'gameplay.codex.jsonl')
    fs.writeFileSync(source, 'original evidence')
    const originalRename = fs.renameSync.bind(fs)
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(String(from)) === 'gameplay.codex.jsonl') {
        originalRename(from, `${String(from)}.original`)
        fs.writeFileSync(from, 'operator replacement')
      }
      originalRename(from, to)
    })
    try {
      expect(() => archiveChildStreams(dir!, attemptId)).toThrow(/changed while its source entry was retained/)
    } finally {
      spy.mockRestore()
    }
    expect(fs.readFileSync(`${source}.original`, 'utf8')).toBe('original evidence')
    const files = fs.readdirSync(path.join(root, attemptId))
    const archived = files.find((name) => name.endsWith('.archived'))!
    const retained = files.find((name) => name.endsWith('.retained'))!
    expect(fs.readFileSync(path.join(root, attemptId, archived), 'utf8')).toBe('original evidence')
    expect(fs.readFileSync(path.join(root, attemptId, retained), 'utf8')).toBe('operator replacement')
  })

  it('uses an exclusive archive target and preserves a concurrent claimant', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-archive-target-race-'))
    const root = agentsDir(dir)
    const attemptId = randomUUID()
    fs.mkdirSync(root, { recursive: true })
    const source = path.join(root, 'gameplay.codex.jsonl')
    fs.writeFileSync(source, 'original evidence')
    const originalOpen = fs.openSync.bind(fs)
    let planted: string | null = null
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((file, flags, mode) => {
      if (
        planted === null
        && typeof file === 'string'
        && file.endsWith('.archived')
        && typeof flags === 'number'
        && (flags & fs.constants.O_EXCL) !== 0
      ) {
        planted = file
        fs.writeFileSync(file, 'operator claim')
      }
      return originalOpen(file, flags, mode)
    }) as typeof fs.openSync)
    try {
      expect(() => archiveChildStreams(dir!, attemptId)).toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(fs.readFileSync(source, 'utf8')).toBe('original evidence')
    expect(fs.readFileSync(planted!, 'utf8')).toBe('operator claim')
  })
})
