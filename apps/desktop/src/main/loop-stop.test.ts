import { describe, expect, it, vi } from 'vitest'
import type { LoopRecord } from '../shared/loop'
import { stopExistingLoop } from './loop-stop'

describe('stopExistingLoop', () => {
  it('does not mutate history for a valid but nonexistent UUID', () => {
    const stop = vi.fn()
    const result = stopExistingLoop(
      { getLoop: () => null },
      { stop },
      '123e4567-e89b-42d3-a456-426614174000',
    )

    expect(result).toEqual({ ok: false, error: 'Run not found.' })
    expect(stop).not.toHaveBeenCalled()
  })

  it('stops an existing loop and returns an operation result', () => {
    const stop = vi.fn()
    const loop = { id: '123e4567-e89b-42d3-a456-426614174000' } as LoopRecord

    expect(stopExistingLoop({ getLoop: () => loop }, { stop }, loop.id)).toEqual({ ok: true, value: undefined })
    expect(stop).toHaveBeenCalledWith(loop.id)
  })
})
