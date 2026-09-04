import { describe, expect, it } from 'vitest'
import { IPC } from './ipc'

describe('IPC channel contract', () => {
  it('uses unique area:verb names', () => {
    const channels = Object.values(IPC).flatMap((area) => Object.values(area))
    expect(new Set(channels).size).toBe(channels.length)
    expect(channels.every((channel) => /^[a-z]+:[a-z-]+$/.test(channel))).toBe(true)
  })
})
