import { describe, expect, it, vi } from 'vitest'
import { settleQuitSupervisors } from './quit-settlement'

describe('quit settlement', () => {
  it('never authorizes quit when agent settlement rejects', async () => {
    const play = vi.fn(async () => undefined)
    await expect(settleQuitSupervisors(
      async () => { throw new Error(`failed ghp_${'a'.repeat(36)}`) },
      play,
    )).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('failed [REDACTED]'),
    })
    expect(play).toHaveBeenCalledOnce()
  })

  it('authorizes quit only after both supervisors settle', async () => {
    const order: string[] = []
    await expect(settleQuitSupervisors(
      async () => { order.push('agents'); return true },
      async () => { order.push('play') },
    )).resolves.toEqual({ ok: true, value: undefined })
    expect(order.sort()).toEqual(['agents', 'play'])
  })
})
