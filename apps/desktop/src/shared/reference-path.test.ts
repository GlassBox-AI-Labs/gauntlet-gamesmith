import { describe, expect, it } from 'vitest'
import { referencePackDir, referenceRootForLoop } from './reference-path'

describe('reference pack paths', () => {
  it('derives current and historical roots from one rule', () => {
    expect(referencePackDir('loop-123')).toBe('reference/loop-123')
    expect(referenceRootForLoop('loop-123', true)).toBe('reference/loop-123')
    expect(referenceRootForLoop('loop-123', false)).toBe('reference')
  })

  it('rejects path-bearing ids', () => {
    expect(() => referencePackDir('../escape')).toThrow('Invalid loop id')
    expect(() => referencePackDir('/absolute')).toThrow('Invalid loop id')
  })
})
