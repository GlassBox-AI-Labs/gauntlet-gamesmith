import { createClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { Catalog } from '@gauntlet/data/api/catalog'
import { GameServer } from '@gauntlet/data/api/game-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
let server: GameServer | undefined

export function GET(request: Request) {
  if (!server) {
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
    server = new GameServer(new Catalog(client, secret, capture), capture)
  }
  return server.serve(request)
}
export const HEAD = GET
