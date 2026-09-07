import http from 'node:http'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { Catalog } from '@gauntlet/data/api/catalog'
import { GameServer } from '@gauntlet/data/api/game-server'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { captureServerError } from '../src/lib/capture'
const client = createClient<Database>(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)
const catalog = new Catalog(
  client,
  process.env.CATALOG_SECRET!,
  captureServerError,
)
const server = new GameServer(catalog, captureServerError)
const games = http.createServer(async (req, res) => {
  try {
    const response = await server.serve(
      new Request(new URL(req.url ?? '/', 'http://local'), {
        method: req.method,
      }),
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (!response.body) {
      res.end()
      return
    }
    await pipeline(
      Readable.fromWeb(
        response.body as import('node:stream/web').ReadableStream,
      ),
      res,
    )
  } catch (error) {
    captureServerError(error, 'game-host.transport')
    if (!res.headersSent) res.writeHead(500, { 'Cache-Control': 'no-store' })
    res.end()
  }
})
games.requestTimeout = 30000
games.listen(Number(process.env.GAME_PORT ?? 4311), '0.0.0.0', () =>
  console.log(
    `Game host: ${process.env.GAME_ORIGIN ?? 'http://localhost:4311'}`,
  ),
)
process.on('SIGINT', () => games.close())
