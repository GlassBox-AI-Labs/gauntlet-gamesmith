import { describe, expect, it } from 'vitest'
import { assertChildSlug, parseChildStreamName } from './child-stream-name'

describe('child stream names', () => {
  it('accepts the documented lowercase-and-hyphen slug grammar', () => {
    expect(parseChildStreamName('research-reddit-2.codex.jsonl')).toEqual({ slug: 'research-reddit-2', harness: 'codex' })
    expect(assertChildSlug('physics-2')).toBe('physics-2')
  })

  it.each([
    '../escape.claude.jsonl',
    'nested.slug.codex.jsonl',
    'UPPER.claude.jsonl',
    'has space.codex.jsonl',
    '_underscore.claude.jsonl',
    `${'a'.repeat(65)}.codex.jsonl`,
  ])('rejects unsafe stream name %s', (file) => {
    expect(parseChildStreamName(file)).toBeNull()
  })

  it.each(['../escape', '/absolute', 'has space', 'UPPER', 'under_score', 'a'.repeat(65)])('rejects unsafe slug %s', (slug) => {
    expect(() => assertChildSlug(slug)).toThrow(/must match/)
  })
})
