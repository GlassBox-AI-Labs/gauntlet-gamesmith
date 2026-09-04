import { describe, expect, it } from 'vitest'
import { developmentRendererUrl } from './dev-renderer-url'

describe('developmentRendererUrl', () => {
  it('accepts loopback development servers only in an unpackaged app', () => {
    expect(developmentRendererUrl('http://localhost:5173', false)).toBe('http://localhost:5173/')
    expect(developmentRendererUrl('https://127.0.0.1:4173/path', false)).toBe('https://127.0.0.1:4173/path')
    expect(developmentRendererUrl('http://[::1]:5173', false)).toBe('http://[::1]:5173/')
    expect(developmentRendererUrl('https://example.com/app', false)).toBeNull()
    expect(developmentRendererUrl('file:///tmp/renderer.html', false)).toBeNull()
    expect(developmentRendererUrl('http://localhost:5173', true)).toBeNull()
  })
})
