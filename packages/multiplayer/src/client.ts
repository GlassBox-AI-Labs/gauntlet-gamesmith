import type { MultiplayerClient as PublicClient } from './browser-api'
import { launchSchema, sessionSchema, roomSchema, serverMessage, UPDATE_INTERVAL_MS, type Launch, type Session, type Room, type State, type Snapshot, type ServerMessage } from './index'

export type NetworkCondition = 'local' | 'internet' | 'unstable'
export interface Diagnostics { status: 'lobby' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error'; rttMs: number; snapshotAgeMs: number; instance: string; error: string }
export class MultiplayerClient implements PublicClient {
  session: Session | null = null
  readonly diagnostics: Diagnostics = { status: 'lobby', rttMs: 0, snapshotAgeMs: 0, instance: '', error: '' }
  private socket: WebSocket | null = null
  private offset = 0
  private seq = 0
  private lastSent = 0
  private lastSnapshot = 0
  private closed = false
  private reconnects = 0
  private generation = 0
  private lastPoll = 0
  private polling: Promise<Room> | null = null
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<(snapshot: Snapshot) => void>()
  private changes = new Set<() => void>()
  private condition: NetworkCondition = 'local'
  constructor(readonly launch: Launch) { launchSchema.parse(launch) }
  static fromWindow(): MultiplayerClient {
    return new MultiplayerClient(launchSchema.parse((window as unknown as { gamesmith?: unknown }).gamesmith))
  }
  serverNow() { return Date.now() + this.offset }
  setCondition(condition: NetworkCondition) { this.condition = condition }
  onState(handler: (snapshot: Snapshot) => void) { this.listeners.add(handler); return () => { this.listeners.delete(handler) } }
  onChange(handler: () => void) { this.changes.add(handler); return () => { this.changes.delete(handler) } }
  private changed() { this.diagnostics.snapshotAgeMs = this.lastSnapshot ? Date.now() - this.lastSnapshot : 0; for (const f of this.changes) f() }
  private later(fn: () => void, ms: number) { const timer = setTimeout(() => { this.timers.delete(timer); if (!this.closed) fn() }, ms); this.timers.add(timer) }
  private async request(body: unknown) {
    const sent = Date.now()
    const response = await fetch(this.launch.apiUrl, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) })
    const value = await response.json().catch(() => { throw new Error('Multiplayer server returned an unreadable response.') })
    if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'Multiplayer is temporarily unavailable.')
    if (typeof value.serverTime === 'number') this.offset = value.serverTime - (sent + Date.now()) / 2
    return value
  }
  async join(name: string, roomId?: string): Promise<Room> {
    this.leave(); this.closed = false; this.reconnects = 0; this.seq = 0; this.lastSent = 0
    const generation = this.generation
    const session = sessionSchema.parse(await this.request({ action: 'join', gameId: this.launch.gameId, releaseId: this.launch.releaseId, previewToken: this.launch.previewToken, name, roomId }))
    if (this.closed || generation !== this.generation) {
      void this.request({ action: 'leave', ticket: session.ticket }).catch(() => {})
      throw new Error('Joining was cancelled.')
    }
    this.session = session
    this.diagnostics.status = 'lobby'; this.diagnostics.error = ''; this.changed()
    return this.session.room
  }
  async room(start = false): Promise<Room> {
    if (!this.session) throw new Error('Join a session first.')
    if (this.polling && !start) return this.polling
    if (!start && Date.now() - this.lastPoll < 600) return this.session.room
    const session = this.session
    const pending = this.request({ action: start ? 'start' : 'status', ticket: session.ticket }).then(value => {
      const room = roomSchema.parse(value.room)
      if (this.session === session) { this.session.room = room; this.lastPoll = Date.now() }
      return room
    }).finally(() => { if (this.polling === pending) this.polling = null })
    if (!start) this.polling = pending
    return pending
  }
  connect(): void {
    const session = this.session
    if (!session || this.closed || this.socket) return
    if (session.room.endAt && session.room.endAt <= this.serverNow()) { this.diagnostics.status = 'ended'; this.changed(); return }
    const generation = ++this.generation
    this.diagnostics.status = this.reconnects ? 'reconnecting' : 'connecting'; this.changed()
    const socket = new WebSocket(session.socketUrl); this.socket = socket
    const current = () => this.generation === generation && !this.closed
    this.later(() => { if (current() && this.diagnostics.status !== 'connected') socket.close(4000, 'Connection timed out') }, 10000)
    socket.onopen = () => { if (current()) socket.send(JSON.stringify({ type: 'auth', ticket: session.ticket })) }
    socket.onmessage = event => {
      if (!current()) return
      let message: ServerMessage
      try { if (String(event.data).length > 8192) return; message = serverMessage.parse(JSON.parse(String(event.data))) } catch { return }
      if (message.type === 'welcome') {
        this.session!.room = message.room; this.reconnects = 0; this.diagnostics.status = 'connected'; this.diagnostics.error = ''; this.diagnostics.instance = message.instance
        if (this.pingTimer) clearInterval(this.pingTimer)
        const ping = () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', time: Date.now() })) }
        ping(); this.pingTimer = setInterval(ping, 2000); this.changed()
      } else if (message.type === 'pong') {
        this.diagnostics.rttMs = Date.now() - message.time
        this.offset = message.serverTime - (message.time + Date.now()) / 2; this.changed()
      } else if (message.type === 'state') {
        const deliver = () => { if (!current()) return; this.lastSnapshot = Date.now(); for (const listener of this.listeners) listener(message) }
        // App playtesting can delay state delivery; gameplay and server deadlines are unchanged.
        const delay = this.condition === 'internet' ? 50 : this.condition === 'unstable' ? 30 + Math.random() * 120 : 0
        if (delay) this.later(deliver, delay); else deliver()
      } else if (message.type === 'ended') { this.diagnostics.status = 'ended'; this.changed() }
      else if (message.type === 'error') { this.diagnostics.error = message.message; this.changed() }
    }
    socket.onerror = () => { if (current()) { this.diagnostics.error = 'Connection interrupted. Reconnecting…'; this.changed() } }
    socket.onclose = event => {
      if (!current()) return
      this.socket = null
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
      if (event.code === 1000 || (session.room.endAt && this.serverNow() >= session.room.endAt)) { this.diagnostics.status = 'ended'; this.changed(); return }
      if (event.code === 1008 || ++this.reconnects > 5) { this.diagnostics.status = 'error'; this.diagnostics.error = 'Unable to rejoin this session. Return to the lobby.'; this.changed(); return }
      this.diagnostics.status = 'reconnecting'; this.changed(); this.later(() => this.connect(), Math.min(3000, 250 * 2 ** this.reconnects))
    }
  }
  publish(state: State) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.diagnostics.status !== 'connected' || performance.now() - this.lastSent < UPDATE_INTERVAL_MS || this.socket.bufferedAmount > 32 * 1024) return
    this.lastSent = performance.now()
    this.socket.send(JSON.stringify({ type: 'state', seq: ++this.seq, at: this.serverNow(), state }))
  }
  leave() {
    if (this.session && !this.session.room.startAt) void this.request({ action: 'leave', ticket: this.session.ticket }).catch(() => { /* Room lifetime bounds seats when offline. */ })
    this.closed = true; this.generation++
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear(); if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null; this.socket?.close(1000, 'Left session'); this.socket = null; this.session = null
  }
}
