import { MultiplayerCatalog } from '@gauntlet/data/api/multiplayer'
import { createCatalog } from '@/lib/catalog'
import { config } from '@/lib/config'
import { readBody } from '@/lib/http'
import { multiplayerServer } from '@/lib/multiplayer'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 20
// Opaque sandbox frames use Origin: null. Guest tickets, not cookies or Origin, authorize rooms.
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' }
export function OPTIONS() { return new Response(null, { status: 204, headers }) }
export async function POST(request: Request) {
  try {
    const multiplayer = new MultiplayerCatalog(createCatalog(), multiplayerServer(), config().secret)
    return Response.json(await multiplayer.request(await readBody(request), request.headers.get('x-real-ip') ?? 'local'), { headers })
  } catch (error) {
    console.error(JSON.stringify({ context: 'multiplayer.request', error: error instanceof Error ? error.name : 'UnknownError' }))
    const message = error instanceof Error && /^(This |Too many room |The first player)/.test(error.message) ? error.message : 'Multiplayer is temporarily unavailable. Try again.'
    return Response.json({ error: message }, { status: 400, headers })
  }
}
