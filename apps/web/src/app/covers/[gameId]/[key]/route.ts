import { publicGames } from '@gauntlet/data/api/catalog'
import { createAnonClient } from '@/lib/supabase-anon'
import { captureServerError } from '@/lib/capture'
import { createCatalog } from '@/lib/catalog'
import { readOnlyCatalogOrigin } from '@/lib/config'
export async function GET(
  _request: Request,
  context: { params: Promise<{ gameId: string; key: string }> },
) {
  const { gameId, key } = await context.params
  const games = await publicGames(createAnonClient(), captureServerError)
  if (!games.some((g) => g.id === gameId && g.cover_key === key))
    return new Response('Not found', { status: 404 })
  const publicOrigin = readOnlyCatalogOrigin()
  if (publicOrigin) {
    const target = new URL(`/covers/${encodeURIComponent(gameId)}/${encodeURIComponent(key)}`, publicOrigin)
    if (target.origin === new URL(_request.url).origin)
      throw new Error('Read-only covers require a separate catalog origin.')
    const cover = await fetch(target, { cache: 'no-store', redirect: 'error' })
    return new Response(cover.body, {
      status: cover.status,
      headers: {
        'Content-Type': 'image/png',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    })
  }
  const bytes = await createCatalog().coverBytes(gameId, key)
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    },
  })
}
