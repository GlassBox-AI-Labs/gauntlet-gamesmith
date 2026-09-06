import { describe, expect, it, vi } from 'vitest'
import type { BuildRecord } from '../shared/build'
import { stopExistingBuild } from './build-stop'

describe('stopExistingLoop', () => {
  it('does not mutate history for a valid but nonexistent UUID', () => {
    const stop = vi.fn()
    const result = stopExistingBuild(
      { getBuild: () => null },
      { stop },
      '123e4567-e89b-42d3-a456-426614174000',
    )

    expect(result).toEqual({ ok: false, error: 'Build not found.' })
    expect(stop).not.toHaveBeenCalled()
  })

  it('stops an existing build and returns an operation result', () => {
    const stop = vi.fn()
    const build = { id: '123e4567-e89b-42d3-a456-426614174000' } as BuildRecord

    expect(stopExistingBuild({ getBuild: () => build }, { stop }, build.id)).toEqual({ ok: true, value: undefined })
    expect(stop).toHaveBeenCalledWith(build.id)
  })
})
