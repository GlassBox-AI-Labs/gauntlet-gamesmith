import { describe, expect, it } from 'vitest'
import { referencePackDir, referenceRootForBuild } from './reference-path'

describe('reference pack paths', () => {
  it('derives current and historical roots from one rule', () => {
    expect(referencePackDir('build-123')).toBe('reference/build-123')
    expect(referenceRootForBuild('build-123', true)).toBe('reference/build-123')
    expect(referenceRootForBuild('build-123', false)).toBe('reference')
  })

  it('rejects path-bearing ids', () => {
    expect(() => referencePackDir('../escape')).toThrow('Invalid build id')
    expect(() => referencePackDir('/absolute')).toThrow('Invalid build id')
  })
})
