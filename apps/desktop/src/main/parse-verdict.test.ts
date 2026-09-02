import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseVerdict, readVerdictArtifact } from './loop-runner'

describe('parseVerdict', () => {
  it('parses a fenced json block', () => {
    const text = `The lighting is flat and the weapon models are placeholder quality.

\`\`\`json
{"score": 0.34, "pass": false, "summary": "Far below AAA.", "findings": [{"severity": "critical", "text": "No PBR materials"}]}
\`\`\``
    const verdict = parseVerdict(text)
    expect(verdict).not.toBeNull()
    expect(verdict!.score).toBeCloseTo(0.34)
    expect(verdict!.pass).toBe(false)
    expect(verdict!.findings).toHaveLength(1)
  })

  it('takes the last fenced block when several exist', () => {
    const text = '```json\n{"score": 0.1, "pass": false, "summary": "draft"}\n```\nrevised:\n```json\n{"score": 0.55, "pass": false, "summary": "final"}\n```'
    expect(parseVerdict(text)!.score).toBeCloseTo(0.55)
  })

  it('parses a bare trailing object', () => {
    const text = 'Verdict follows.\n{"score": 0.72, "pass": false, "summary": "Getting closer", "findings": []}'
    expect(parseVerdict(text)!.score).toBeCloseTo(0.72)
  })

  it('normalizes a 0-10 scale to 0-1', () => {
    expect(parseVerdict('{"score": 7.5, "pass": false, "summary": "x"}')!.score).toBeCloseTo(0.75)
  })

  it('only passes on an explicit boolean true', () => {
    expect(parseVerdict('{"score": 0.95, "pass": "true", "summary": "x"}')!.pass).toBe(false)
    expect(parseVerdict('{"score": 0.95, "pass": true, "summary": "x"}')!.pass).toBe(true)
  })

  it('returns null when there is no verdict', () => {
    expect(parseVerdict('I could not run the project at all.')).toBeNull()
    expect(parseVerdict('{"pass": true, "summary": "no score"}')).toBeNull()
  })

  it('coerces string findings and clamps score', () => {
    const verdict = parseVerdict('{"score": 1.7, "pass": false, "summary": "x", "findings": ["too dark"]}')
    expect(verdict!.score).toBeLessThanOrEqual(1)
    expect(verdict!.findings[0]).toEqual({ severity: 'note', text: 'too dark' })
  })
})

describe('readVerdictArtifact', () => {
  const write = (round: number, content: string): string => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-verdict-'))
    fs.mkdirSync(path.join(workspace, 'critique', `round-${round}`), { recursive: true })
    fs.writeFileSync(path.join(workspace, 'critique', `round-${round}`, 'verdict.json'), content)
    return workspace
  }

  it('recovers a plain-JSON verdict the final message failed to carry', () => {
    const workspace = write(2, '{"score": 0.42, "pass": false, "summary": "Engine faithful, presentation short.", "findings": [{"severity": "major", "text": "No bloom on maze walls"}]}')
    const verdict = readVerdictArtifact(workspace, 2, Date.now() - 60_000)
    expect(verdict!.score).toBeCloseTo(0.42)
    expect(verdict!.findings).toHaveLength(1)
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it('rejects a file older than the loop, and missing or invalid files', () => {
    const workspace = write(2, '{"score": 0.9, "pass": true, "summary": "stale"}')
    expect(readVerdictArtifact(workspace, 2, Date.now() + 60_000)).toBeNull()
    expect(readVerdictArtifact(workspace, 3, 0)).toBeNull()
    const invalid = write(1, 'not json at all')
    expect(readVerdictArtifact(invalid, 1, 0)).toBeNull()
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(invalid, { recursive: true, force: true })
  })
})
