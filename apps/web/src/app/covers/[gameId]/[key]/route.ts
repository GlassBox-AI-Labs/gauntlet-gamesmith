import { publicGames } from '@gauntlet/data/api/catalog'
import { createAnonClient } from '@/lib/supabase-anon'
import { captureServerError } from '@/lib/capture'
import { createCatalog } from '@/lib/catalog'
export async function GET(
  _request: Request,
  context: { params: Promise<{ gameId: string; key: string }> },
) {
  const { gameId, key } = await context.params
  const games = await publicGames(createAnonClient(), captureServerError)
  if (!games.some((g) => g.id === gameId && g.cover_key === key))
    return new Response('Not found', { status: 404 })
  const bytes = await createCatalog().coverBytes(gameId, key)
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    },
  })
}
