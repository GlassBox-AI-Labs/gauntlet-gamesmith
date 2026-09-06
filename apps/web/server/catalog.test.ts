import { describe, it, expect } from 'vitest'
import { Catalog } from './catalog'
import { Supabase } from './supabase'
describe('preview capabilities', () => {
  const catalog = new Catalog(new Supabase({ url: 'http://unused', key: 'test', anon: 'test' }))
  it('binds access to the exact release and rejects malformed or forged tokens', () => {
    const token = catalog.previewToken('release-one')
    expect(catalog.validPreview('release-one', token)).toBe(true)
    expect(catalog.validPreview('release-two', token)).toBe(false)
    expect(catalog.validPreview('release-one', token.replace(/.$/, token.endsWith('a') ? 'b' : 'a'))).toBe(false)
    expect(catalog.validPreview('release-one', '')).toBe(false)
    expect(catalog.validPreview('release-one', `1000000000.${'0'.repeat(64)}`)).toBe(false)
  })
  it('revokes preview tokens when the server restarts', () => {
    const restarted = new Catalog(catalog.db)
    expect(restarted.validPreview('r', catalog.previewToken('r'))).toBe(false)
  })
})
