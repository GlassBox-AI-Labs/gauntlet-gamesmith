import { describe, expect, it } from 'vitest'
import { buildCriticPrompt, buildReferencePrompt, composeImplementPrompt } from './prompts'

const rules = 'Delegate ALL substantial implementation work to implementer agents.'

describe('loop prompts', () => {
  it('gathers a scoped, attributable pack without implementing', () => {
    const prompt = buildReferencePrompt('Build a game like Control', 'reference/loop-123')

    expect(prompt).toContain('one-time Reference Study')
    expect(prompt).toContain('./reference/loop-123')
    expect(prompt).toContain('at least 8 useful, high-resolution stills')
    expect(prompt).toContain('extract at least 8 frames')
    expect(prompt).toContain('manifest.json')
    expect(prompt).toContain('do not begin implementation')
  })

  it('makes the first implementer consume the completed pack', () => {
    const prompt = composeImplementPrompt('Build a game like Control', 1, null, rules, 'reference/loop-123')

    expect(prompt).toContain('read ./reference/loop-123/README.md')
    expect(prompt).toContain('VIEW the relevant stills and motion frames')
    expect(prompt).toContain('Do not replace or redownload them')
    expect(prompt).not.toContain('yt-dlp')
  })

  it('makes later implementers reuse the same reference pack', () => {
    const prompt = composeImplementPrompt(
      'Build a game like Control',
      2,
      {
        score: 0.4,
        pass: false,
        summary: 'Needs work',
        findings: [{ severity: 'major', text: 'Flat lighting' }],
      },
      rules,
      'reference/loop-123',
    )

    expect(prompt).toContain('read ./reference/loop-123/README.md')
    expect(prompt).toContain('Flat lighting')
    expect(prompt).not.toContain('yt-dlp')
  })

  it('has critics audit the prepared pack instead of redownloading it every round', () => {
    const prompt = buildCriticPrompt('Build a game like Control', 3, 'reference/loop-123')

    expect(prompt).toContain('Audit the frozen AAA Reference Pack in ./reference/loop-123 FIRST')
    expect(prompt).toContain('Do not redownload or replace it during critique')
    expect(prompt).toContain('record that as a critical process finding')
    expect(prompt).toContain('critique/round-3/shots/')
    expect(prompt).toContain('critique/round-3/refs/')
  })
})
