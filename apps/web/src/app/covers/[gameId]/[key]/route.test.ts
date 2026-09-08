import { afterEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@gauntlet/data/api/catalog', () => ({ publicGames: vi.fn(async () => [{ id: 'published-game', cover_key: 'current-cover' }]) }))
vi.mock('@/lib/supabase-anon', () => ({ createAnonClient: vi.fn() }))
vi.mock('@/lib/catalog', () => ({ createCatalog: vi.fn(() => { throw new Error('Privileged client must not run') }) }))
import { GET } from './route'
import { createCatalog } from '@/lib/catalog'

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
it('redirects only the currently published cover to the public catalog', async () => {
  vi.stubEnv('CATALOG_READ_ONLY_ORIGIN', 'https://gauntletgamesmith.com')
  const request = new Request('https://branch.example.com/covers/published-game/current-cover')
  const result = await GET(request, { params: Promise.resolve({ gameId: 'published-game', key: 'current-cover' }) })
  expect(result.status).toBe(307)
  expect(result.headers.get('location')).toBe('https://gauntletgamesmith.com/covers/published-game/current-cover')
  expect(result.headers.get('cache-control')).toBe('no-store')
  expect(createCatalog).not.toHaveBeenCalled()
})
it('does not redirect private or obsolete covers', async () => {
  vi.stubEnv('CATALOG_READ_ONLY_ORIGIN', 'https://gauntletgamesmith.com')
  const result = await GET(new Request('https://branch.example.com/covers/published-game/old-cover'), {
    params: Promise.resolve({ gameId: 'published-game', key: 'old-cover' }),
  })
  expect(result.status).toBe(404)
  expect(result.headers.get('location')).toBeNull()
  expect(createCatalog).not.toHaveBeenCalled()
})
