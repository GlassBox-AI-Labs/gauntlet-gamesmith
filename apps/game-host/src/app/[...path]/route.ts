import { createClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { Catalog } from '@gauntlet/data/api/catalog'
import { GameServer, PublicGamePreview } from '@gauntlet/data/api/game-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
let server: GameServer | PublicGamePreview | undefined

export function GET(request: Request) {
  if (!server) {
    // This mode never initializes privileged clients, even if credentials are present.
    if (process.env.GAME_READ_ONLY_ORIGIN) {
      server = new PublicGamePreview(process.env.GAME_READ_ONLY_ORIGIN, (error, context) =>
        console.error(JSON.stringify({ context, error: error instanceof Error ? error.name : 'UpstreamError' })),
      )
      return server.serve(request)
    }
    const url = process.env.SUPABASE_URL,
      key = process.env.SUPABASE_SERVICE_ROLE_KEY
    const secret = process.env.CATALOG_SECRET
    if (!url || !key || !secret)
      throw new Error('Configure the game host before serving games.')
    const capture = (error: unknown, context: string) =>
      console.error(
        JSON.stringify({
          context,
          error: error instanceof Error ? error.name : 'BackendError',
        }),
      )
    const client = createClient<Database>(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    server = new GameServer(new Catalog(client, secret, capture), capture, process.env.MULTIPLAYER_API_ORIGIN && process.env.MULTIPLAYER_SOCKET_URL ? { apiOrigin: process.env.MULTIPLAYER_API_ORIGIN, socketUrl: process.env.MULTIPLAYER_SOCKET_URL } : undefined)
  }
  return server.serve(request)
}
export const HEAD = GET
