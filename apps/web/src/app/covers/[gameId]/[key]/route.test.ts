import { afterEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@gauntlet/data/api/catalog', () => ({ publicGames: vi.fn(async () => [{ id: 'published-game', cover_key: 'current-cover' }]) }))
vi.mock('@/lib/supabase-anon', () => ({ createAnonClient: vi.fn() }))
vi.mock('@/lib/catalog', () => ({ createCatalog: vi.fn(() => { throw new Error('Privileged client must not run') }) }))
import { GET } from './route'
import { createCatalog } from '@/lib/catalog'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks() })
it('streams only the currently published cover from the public catalog without credentials', async () => {
  vi.stubEnv('CATALOG_READ_ONLY_ORIGIN', 'https://gauntletgamesmith.com')
  const fetchCover = vi.fn(async () => new Response('public-cover-bytes'))
  vi.stubGlobal('fetch', fetchCover)
  const request = new Request('https://branch.example.com/covers/published-game/current-cover')
  const result = await GET(request, { params: Promise.resolve({ gameId: 'published-game', key: 'current-cover' }) })
  expect(result.status).toBe(200)
  expect(await result.text()).toBe('public-cover-bytes')
  expect(fetchCover).toHaveBeenCalledWith(new URL('https://gauntletgamesmith.com/covers/published-game/current-cover'), { cache: 'no-store', redirect: 'error' })
  expect(result.headers.get('cache-control')).toBe('no-store')
  expect(createCatalog).not.toHaveBeenCalled()
})
it('does not request private or obsolete covers', async () => {
  vi.stubEnv('CATALOG_READ_ONLY_ORIGIN', 'https://gauntletgamesmith.com')
  const fetchCover = vi.fn()
  vi.stubGlobal('fetch', fetchCover)
  const result = await GET(new Request('https://branch.example.com/covers/published-game/old-cover'), {
    params: Promise.resolve({ gameId: 'published-game', key: 'old-cover' }),
  })
  expect(result.status).toBe(404)
  expect(result.headers.get('location')).toBeNull()
  expect(fetchCover).not.toHaveBeenCalled()
  expect(createCatalog).not.toHaveBeenCalled()
})
