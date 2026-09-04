import { describe, expect, it } from 'vitest'
import { normalizeSessionId } from './session-id'

describe('normalizeSessionId', () => {
  it.each(['session-1', '0198_ABC', 'a'])('accepts bounded path-safe id %s', (id) => {
    expect(normalizeSessionId(id)).toBe(id)
  })

  it.each(['../escape', '/absolute', 'has space', '.hidden', 'a'.repeat(129), '', `ghp_${'a'.repeat(36)}`, `sk-proj-${'b'.repeat(24)}`, null])('rejects unsafe or credential-shaped id %s', (id) => {
    expect(normalizeSessionId(id)).toBeNull()
  })
})
