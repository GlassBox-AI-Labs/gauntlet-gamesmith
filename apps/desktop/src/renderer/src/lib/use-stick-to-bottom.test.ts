import { describe, expect, it } from 'vitest'
import { atBottom } from './use-stick-to-bottom'

describe('atBottom', () => {
  it('is true at the bottom and within a few pixels of it', () => {
    expect(atBottom({ scrollHeight: 1000, scrollTop: 580, clientHeight: 420 })).toBe(true)
    expect(atBottom({ scrollHeight: 1000, scrollTop: 575, clientHeight: 420 })).toBe(true)
  })

  it('is true when the content does not overflow', () => {
    expect(atBottom({ scrollHeight: 420, scrollTop: 0, clientHeight: 420 })).toBe(true)
  })

  it('is false once the user has scrolled up', () => {
    expect(atBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 420 })).toBe(false)
  })
})
