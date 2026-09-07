import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { clientMessage, MAX_MESSAGE_BYTES, type Room, type Player, type Snapshot, type Session, type MultiplayerManifest } from './index'

export interface RoomRef { scope: string; roomId: string }
export interface Ticket extends RoomRef { playerId: string; expiresAt: number }
export interface RoomStore {
  join(scope: string, gameId: string, releaseId: string, player: Player, manifest: MultiplayerManifest, roomId?: string): Promise<Room>
  read(ref: RoomRef): Promise<Room>
  start(ref: Ticket): Promise<Room>
  leave(ref: Ticket): Promise<void>
  publish(ref: Ticket, snapshot: Snapshot): Promise<void>
  subscribe(ref: RoomRef, receive: (snapshot: Snapshot) => void): Promise<() => Promise<void>>
  limit(key: string, count: number, seconds: number): Promise<boolean>
}
const ticketSchema = z.object({ scope: z.string().regex(/^[a-f0-9]{32}$/), roomId: z.string().uuid(), playerId: z.string().uuid(), expiresAt: z.number().int() }).strict()
export function roomScope(secret: string, gameId: string, releaseId: string, preview: boolean): string {
  return createHmac('sha256', secret).update(`${gameId}:${releaseId}:${preview ? 'preview' : 'public'}`).digest('hex').slice(0, 32)
}
export class MultiplayerServer {
  constructor(readonly store: RoomStore, private secret: string, readonly socketUrl: string) {
    if (secret.length < 32) throw new Error('Multiplayer signing secret is missing.')
  }
  private sign(body: string) { return createHmac('sha256', this.secret).update(`multiplayer:v1:${body}`).digest('base64url') }
  ticket(claims: Ticket): string { const body = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${body}.${this.sign(body)}` }
  verify(token: string): Ticket {
    if (typeof token !== 'string' || token.length > 3000) throw new Error('Invalid room ticket.')
    const [body, signature, extra] = token.split('.')
    const actual = Buffer.from(signature ?? ''), expected = Buffer.from(this.sign(body ?? ''))
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid room ticket.')
    const claims = ticketSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')))
    if (claims.expiresAt <= Date.now()) throw new Error('This session ended. Join another session.')
    return claims
  }
  async join(input: { scope: string; gameId: string; releaseId: string; name: string; manifest: MultiplayerManifest; roomId?: string }): Promise<Session> {
    const player = { id: randomUUID(), name: input.name, slot: 0 }
    const room = await this.store.join(input.scope, input.gameId, input.releaseId, player, input.manifest, input.roomId)
    return { room, playerId: player.id, ticket: this.ticket({ scope: room.scope, roomId: room.id, playerId: player.id, expiresAt: room.expiresAt }), serverTime: Date.now(), socketUrl: this.socketUrl }
  }
  async room(token: string, start = false) {
    const claims = this.verify(token)
    const room = start ? await this.store.start(claims) : await this.store.read(claims)
    if (!room.players.some(p => p.id === claims.playerId)) throw new Error('Player is not in this room.')
    return { room, serverTime: Date.now() }
  }
}

export interface RelaySocket {
  readyState: number
  bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: { toString(): string }) => void): void
  on(event: 'close' | 'error', listener: () => void): void
}
/** One connection; all room state and fan-out remain in the shared store. */
export function attachRelay(socket: RelaySocket, service: MultiplayerServer, options: { instance: string; log?: (event: string) => void }): void {
  let claims: Ticket | null = null, unsubscribe: (() => Promise<void>) | null = null
  let closed = false, authenticating = false, pending = false, count = 0, windowAt = Date.now()
  const timers: ReturnType<typeof setTimeout>[] = []
  const send = (message: unknown) => {
    if (closed || socket.readyState !== 1) return
    if (socket.bufferedAmount > 128 * 1024) { socket.close(1013, 'Connection is too slow. Reconnecting.'); return }
    socket.send(JSON.stringify(message))
  }
  const stop = () => {
    if (closed) return
    closed = true
    for (const timer of timers) clearTimeout(timer)
    void unsubscribe?.().catch(() => options.log?.('multiplayer subscription cleanup failed'))
    options.log?.('multiplayer connection closed')
  }
  socket.on('close', stop); socket.on('error', stop)
  timers.push(setTimeout(() => { if (!claims) socket.close(1008, 'Room ticket required.') }, 5000))
  socket.on('message', raw => {
    const text = raw.toString()
    if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) { socket.close(1009, 'Message too large.'); return }
    const now = Date.now()
    if (now - windowAt >= 1000) { count = 0; windowAt = now }
    if (++count > 40) { socket.close(1008, 'Too many messages.'); return }
    let message: z.infer<typeof clientMessage>
    try { message = clientMessage.parse(JSON.parse(text)) } catch { socket.close(1008, 'Invalid multiplayer message.'); return }
    if (message.type === 'auth') {
      if (claims || authenticating) { socket.close(1008, 'Already authenticated.'); return }
      authenticating = true
      void (async () => {
        const verified = service.verify(message.ticket)
        const room = await service.store.read(verified)
        if (!room.startAt || !room.endAt || room.endAt <= Date.now() || !room.players.some(p => p.id === verified.playerId)) throw new Error('Session is not active.')
        const off = await service.store.subscribe(verified, event => { if (event.playerId !== verified.playerId) send(event) })
        if (closed) { await off(); return }
        unsubscribe = off; claims = verified
        timers.push(setTimeout(() => { send({ type: 'ended', serverTime: Date.now() }); socket.close(1000, 'Session ended.') }, Math.max(0, room.endAt - Date.now())))
        send({ type: 'welcome', room, playerId: verified.playerId, serverTime: Date.now(), instance: options.instance })
        options.log?.(`multiplayer joined room ${room.id}`)
      })().catch(() => { send({ type: 'error', message: 'This session is unavailable. Return to the lobby.' }); socket.close(1008, 'Room unavailable.') })
      return
    }
    if (!claims) { socket.close(1008, 'Room ticket required.'); return }
    if (message.type === 'ping') { send({ type: 'pong', time: message.time, serverTime: Date.now() }); return }
    // Keep transport backpressure bounded: stale position updates are replaceable.
    if (pending) return
    pending = true
    const snapshot: Snapshot = { type: 'state', playerId: claims.playerId, seq: message.seq, at: Math.max(now - 1000, Math.min(now + 50, message.at)), state: message.state }
    void service.store.publish(claims, snapshot).catch(() => {
      send({ type: 'error', message: 'Multiplayer connection interrupted. Reconnecting…' })
      socket.close(1013, 'Relay unavailable.')
    }).finally(() => { pending = false })
  })
}
