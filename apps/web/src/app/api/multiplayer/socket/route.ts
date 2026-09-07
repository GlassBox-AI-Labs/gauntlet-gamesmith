import { experimental_upgradeWebSocket } from '@vercel/functions'
import { attachRelay } from '@gauntlet/multiplayer/server'
import { MAX_MESSAGE_BYTES } from '@gauntlet/multiplayer'
import { multiplayerServer } from '@/lib/multiplayer'
import { randomUUID } from 'node:crypto'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300
const instance = randomUUID()
export async function GET(request: Request) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return Response.json({ service: 'gamesmith-multiplayer', protocol: 1, sessionSeconds: 180 }, { status: 426 })
  const server = multiplayerServer()
  return experimental_upgradeWebSocket(socket => attachRelay(socket, server, { instance, log: event => console.log(event) }), { maxPayload: MAX_MESSAGE_BYTES })
}
