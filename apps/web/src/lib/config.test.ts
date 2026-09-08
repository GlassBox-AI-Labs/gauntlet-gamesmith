import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { config, publicConfig, readOnlyCatalogOrigin } from './config'

afterEach(() => vi.unstubAllEnvs())
describe('read-only branch previews', () => {
  it('allows public reads without publishing credentials', () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'public-test-key')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined)
    vi.stubEnv('CATALOG_SECRET', undefined)
    vi.stubEnv('CATALOG_READ_ONLY_ORIGIN', 'https://gauntletgamesmith.com')
    expect(publicConfig()).toEqual({ url: 'https://example.supabase.co', anon: 'public-test-key' })
    expect(config).toThrow('read-only preview')
  })
  it('blocks privileged clients even if credentials are accidentally supplied', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key')
    vi.stubEnv('CATALOG_SECRET', 'test-secret')
    vi.stubEnv('CATALOG_READ_ONLY_ORIGIN', 'https://gauntletgamesmith.com')
    expect(config).toThrow('read-only preview')
  })
  it.each(['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?x=1'])('rejects an invalid cover source: %s', (origin) => {
    vi.stubEnv('CATALOG_READ_ONLY_ORIGIN', origin)
    expect(readOnlyCatalogOrigin).toThrow()
  })
  it('keeps the normal production configuration', () => {
    vi.stubEnv('CATALOG_READ_ONLY_ORIGIN', undefined)
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'public-test-key')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key')
    vi.stubEnv('CATALOG_SECRET', 'test-secret')
    expect(config().key).toBe('test-service-key')
  })
})
