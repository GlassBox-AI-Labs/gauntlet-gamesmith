import { describe, expect, it } from 'vitest'
import { parseVerdict } from './loop-runner'

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
