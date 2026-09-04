import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseVerdictArtifact, prepareVerdictArtifact, readVerdictArtifact, verdictArtifactRelativePath } from './verdict'

const REVISION = 'a'.repeat(40)
const dirs: string[] = []

function write(round: number, value: unknown): { workspace: string; file: string; runId: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-verdict-'))
  dirs.push(workspace)
  const runId = randomUUID()
  const dir = path.join(workspace, 'critique', `round-${round}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(workspace, verdictArtifactRelativePath(round, runId))
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  return { workspace, file, runId }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('parseVerdictArtifact', () => {
  const valid = {
    revision: REVISION,
    score: 0.34,
    pass: false,
    summary: 'Far below AAA.',
    findings: [{ severity: 'critical', text: 'No PBR materials.', target: 'game' }],
  }

  it('accepts only the strict, revision-bound machine schema', () => {
    expect(parseVerdictArtifact(valid, REVISION).verdict).toEqual({
      score: 0.34,
      pass: false,
      summary: 'Far below AAA.',
      findings: [{ severity: 'critical', text: 'No PBR materials.', target: 'game' }],
    })
    expect(parseVerdictArtifact({ ...valid, pass: 'false' }, REVISION).verdict).toBeNull()
    expect(parseVerdictArtifact({ ...valid, score: '0.34' }, REVISION).verdict).toBeNull()
    expect(parseVerdictArtifact({ ...valid, extra: true }, REVISION).verdict).toBeNull()
    expect(parseVerdictArtifact({ ...valid, findings: ['too dark'] }, REVISION).verdict).toBeNull()
  })

  it('rejects a mismatched revision and an inconsistent pass', () => {
    expect(parseVerdictArtifact(valid, 'b'.repeat(40)).error).toContain('revision does not match')
    expect(parseVerdictArtifact({ ...valid, score: 0.89, pass: true }, REVISION).error).toContain('at least 0.90')
  })
})

describe('readVerdictArtifact', () => {
  const valid = { revision: REVISION, score: 0.42, pass: false, summary: 'Presentation short.', findings: [] }

  it('accepts a fresh regular artifact from this attempt', () => {
    const startedAt = Date.now() - 1_000
    const { workspace, runId } = write(2, valid)
    expect(readVerdictArtifact(workspace, 2, runId, startedAt, REVISION).verdict?.score).toBeCloseTo(0.42)
  })

  it('rejects an artifact left by a prior attempt', () => {
    const { workspace, file, runId } = write(2, valid)
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(file, old, old)
    expect(readVerdictArtifact(workspace, 2, runId, Date.now(), REVISION).error).toContain('predates this critique attempt')
  })

  it('refuses to remove a prior artifact and rejects a future-dated attempt artifact', () => {
    const { workspace, file, runId } = write(2, valid)
    expect(() => prepareVerdictArtifact(workspace, 2, runId)).toThrow(/refusing to replace/)
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(valid))
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(file, future, future)
    expect(readVerdictArtifact(workspace, 2, runId, Date.now() - 1_000, REVISION, Date.now()).error).toContain('future-dated')
  })

  it('rejects prose, missing files, symlinks, and hard links', () => {
    const prose = write(1, '```json\n{"score":0.9}\n```')
    expect(readVerdictArtifact(prose.workspace, 1, prose.runId, 0, REVISION).error).toContain('not valid JSON')
    expect(readVerdictArtifact(prose.workspace, 3, randomUUID(), 0, REVISION).error).toContain('Missing')
    const target = path.join(prose.workspace, 'target.json')
    fs.writeFileSync(target, JSON.stringify(valid))
    fs.unlinkSync(prose.file)
    fs.symlinkSync(target, prose.file)
    expect(readVerdictArtifact(prose.workspace, 1, prose.runId, 0, REVISION).error).toContain('regular file')
    fs.unlinkSync(prose.file)
    fs.linkSync(target, prose.file)
    expect(readVerdictArtifact(prose.workspace, 1, prose.runId, 0, REVISION).error).toContain('owned regular file')
  })

  it('rejects a regular-file swap between inspection and open without consuming replacement bytes', () => {
    const attempt = write(1, valid)
    const canonicalAttemptFile = path.join(fs.realpathSync(attempt.workspace), verdictArtifactRelativePath(1, attempt.runId))
    const original = `${attempt.file}.original`
    const originalOpen = fs.openSync.bind(fs)
    let swapped = false
    vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (!swapped && String(target) === canonicalAttemptFile) {
        swapped = true
        fs.renameSync(attempt.file, original)
        fs.writeFileSync(attempt.file, 'operator replacement')
      }
      return originalOpen(target, flags, mode)
    }) as typeof fs.openSync)

    expect(readVerdictArtifact(attempt.workspace, 1, attempt.runId, 0, REVISION).error).toMatch(/changed identity|not valid JSON/)
    expect(fs.readFileSync(original, 'utf8')).toBe(JSON.stringify(valid))
    expect(fs.readFileSync(attempt.file, 'utf8')).toBe('operator replacement')
  })
})
