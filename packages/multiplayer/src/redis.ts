import { createClient } from 'redis'
import { randomUUID, randomInt } from 'node:crypto'
import { COUNTDOWN_MS, LOBBY_MS, ROOM_LIFETIME_MS, SESSION_MS, roomSchema, type Room, type Player, type MultiplayerManifest, type Snapshot } from './index'
import type { RoomRef, RoomStore, Ticket } from './server'

// Atomic room changes are shared by every Vercel instance. Redis TIME owns deadlines.
const ROOM = `
local nowParts = redis.call('TIME')
local now = tonumber(nowParts[1])*1000 + math.floor(tonumber(nowParts[2])/1000)
local op=ARGV[1]
local id=ARGV[2]
local prefix=ARGV[3]
local explicit=ARGV[4]=='1'
if op=='join' and not explicit then id=redis.call('GET',KEYS[1]) or id end
local key=prefix..id
local raw=redis.call('GET',key)
local room=raw and cjson.decode(raw) or nil
if room and room.expiresAt<=now then room=nil end
if room and room.startAt==cjson.null and room.readyAt<=now then
 room.startAt=now+tonumber(ARGV[8]); room.endAt=room.startAt+tonumber(ARGV[9])
 redis.call('SET',key,cjson.encode(room),'PXAT',room.expiresAt)
end
if op=='join' then
 if room and (room.startAt~=cjson.null or #room.players>=room.maxPlayers) then
  if explicit then return redis.error_reply('This room has started or is full. Join a new session.') end
  id=ARGV[2];key=prefix..id;room=nil
 end
 if not room then
  if explicit then return redis.error_reply('This invite expired. Join a new session.') end
  room=cjson.decode(ARGV[5]);room.id=id;room.createdAt=now;room.readyAt=now+tonumber(ARGV[7]);room.expiresAt=now+tonumber(ARGV[10])
 end
 local player=cjson.decode(ARGV[6]);player.slot=#room.players
 table.insert(room.players,player)
 redis.call('SET',KEYS[1],id,'PXAT',room.readyAt)
elseif not room then return redis.error_reply('This session expired. Join a new session.')
elseif op=='start' then
 local member=false
 for _,p in ipairs(room.players) do if p.id==ARGV[6] then member=true end end
 if not member then return redis.error_reply('Player is not in room.') end
 if room.players[1].id~=ARGV[6] then return redis.error_reply('The first player starts this session.') end
 if room.startAt==cjson.null then room.startAt=now+tonumber(ARGV[8]);room.endAt=room.startAt+tonumber(ARGV[9]) end
elseif op=='leave' and room.startAt==cjson.null then
 local remaining={}
 for _,p in ipairs(room.players) do if p.id~=ARGV[6] then p.slot=#remaining;table.insert(remaining,p) end end
 room.players=remaining
 if #remaining==0 then
  redis.call('DEL',key)
  if redis.call('GET',KEYS[1])==id then redis.call('DEL',KEYS[1]) end
  return cjson.encode(room)
 end
end
redis.call('SET',key,cjson.encode(room),'PXAT',room.expiresAt)
return cjson.encode(room)
`
const PUBLISH = `
local raw=redis.call('GET',KEYS[1]); if not raw then return redis.error_reply('Room expired') end
local room=cjson.decode(raw);local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
if room.startAt==cjson.null or now<room.startAt or now>=room.endAt then return 0 end
local member=false;for _,p in ipairs(room.players) do if p.id==ARGV[1] then member=true end end
if not member then return redis.error_reply('Not a member') end
local last=redis.call('HGET',KEYS[2],ARGV[1]); if last then local old=cjson.decode(last);if tonumber(ARGV[2])<=old.seq or now-old.receivedAt<25 then return 0 end end
local value=cjson.decode(ARGV[3]);value.receivedAt=now
redis.call('HSET',KEYS[2],ARGV[1],cjson.encode(value));redis.call('PEXPIREAT',KEYS[2],room.expiresAt)
redis.call('PUBLISH',KEYS[3],ARGV[3]);return 1
`
const LIMIT = "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end;return n"
export class RedisRoomStore implements RoomStore {
  private command: ReturnType<typeof createClient>
  private subscriber: ReturnType<typeof createClient>
  private connection: Promise<void> | null = null
  private channels = new Map<string, { listeners: Set<(snapshot: Snapshot) => void>; tail: Promise<void>; subscribed: boolean; deliver: (text: string) => void }>()
  constructor(url: string, private namespace: string, onError: () => void = () => {}) {
    if (!/^[a-z0-9-]{1,60}$/.test(namespace)) throw new Error('Invalid multiplayer environment namespace.')
    this.command = createClient({ url, socket: { connectTimeout: 5000, reconnectStrategy: retries => retries < 3 ? 250 * (retries + 1) : false } })
    this.subscriber = this.command.duplicate()
    this.command.on('error', onError); this.subscriber.on('error', onError)
    this.command.on('end', () => { this.connection = null }); this.subscriber.on('end', () => { this.connection = null })
  }
  private async connect() {
    if (!this.connection) this.connection = Promise.all([
      this.command.isOpen ? Promise.resolve() : this.command.connect(),
      this.subscriber.isOpen ? Promise.resolve() : this.subscriber.connect(),
    ]).then(() => {}).catch(error => { this.connection = null; throw error })
    await this.connection
  }
  private prefix(scope: string) {
    if (!/^[a-f0-9]{32}$/.test(scope)) throw new Error('Invalid game scope.')
    return `${this.namespace}:{${scope}}:`
  }
  private async operation(op: string, ref: RoomRef, player: string, room: Room | null = null, explicit = true): Promise<Room> {
    await this.connect()
    const p = this.prefix(ref.scope)
    const result = await this.command.eval(ROOM, { keys: [`${p}open`], arguments: [op, ref.roomId, `${p}room:`, explicit ? '1' : '0', JSON.stringify(room), player, String(LOBBY_MS), String(COUNTDOWN_MS), String(SESSION_MS), String(ROOM_LIFETIME_MS)] })
    const resultRoom = JSON.parse(String(result))
    // Managed Redis Lua engines can omit cjson.null object fields on encode.
    // Normalize the wire contract here so local and hosted clients see nulls.
    return roomSchema.parse({ ...resultRoom, ...(op === 'leave' && !Array.isArray(resultRoom.players) && Object.keys(resultRoom.players ?? {}).length === 0 ? { players: [] } : {}), startAt: resultRoom.startAt ?? null, endAt: resultRoom.endAt ?? null })
  }
  join(scope: string, gameId: string, releaseId: string, player: Player, manifest: MultiplayerManifest, roomId?: string): Promise<Room> {
    const id = roomId ?? randomUUID()
    const room: Room = { id, scope, gameId, releaseId, seed: randomInt(1, 2 ** 30), players: [], maxPlayers: manifest.maxPlayers, createdAt: 0, readyAt: 0, startAt: null, endAt: null, expiresAt: 0 }
    return this.operation('join', { scope, roomId: id }, JSON.stringify(player), room, !!roomId)
  }
  read(ref: RoomRef) { return this.operation('read', ref, '') }
  start(ref: Ticket) { return this.operation('start', ref, ref.playerId) }
  async leave(ref: Ticket) { await this.operation('leave', ref, ref.playerId) }
  async publish(ref: Ticket, snapshot: Snapshot) {
    await this.connect(); const p = this.prefix(ref.scope)
    await this.command.eval(PUBLISH, { keys: [`${p}room:${ref.roomId}`, `${p}state:${ref.roomId}`, `${p}events:${ref.roomId}`], arguments: [ref.playerId, String(snapshot.seq), JSON.stringify(snapshot)] })
  }
  async subscribe(ref: RoomRef, receive: (snapshot: Snapshot) => void) {
    await this.connect()
    const channel = `${this.prefix(ref.scope)}events:${ref.roomId}`
    let entry = this.channels.get(channel)
    if (!entry) {
      const listeners = new Set<(snapshot: Snapshot) => void>()
      entry = { listeners, tail: Promise.resolve(), subscribed: false, deliver: text => {
        const snapshot = JSON.parse(text) as Snapshot
        for (const handler of listeners) handler(snapshot)
      } }
      this.channels.set(channel, entry)
    }
    const owned = entry
    owned.listeners.add(receive)
    const subscribed = owned.tail.catch(() => {}).then(async () => {
      if (!owned.subscribed) { await this.subscriber.subscribe(channel, owned.deliver); owned.subscribed = true }
    })
    owned.tail = subscribed
    try { await subscribed } catch (error) {
      owned.listeners.delete(receive)
      if (!owned.listeners.size && this.channels.get(channel) === owned) this.channels.delete(channel)
      throw error
    }
    return async () => {
      owned.listeners.delete(receive)
      const cleanup = owned.tail.catch(() => {}).then(async () => {
        if (!owned.listeners.size) {
          if (owned.subscribed) await this.subscriber.unsubscribe(channel, owned.deliver)
          owned.subscribed = false
          if (this.channels.get(channel) === owned) this.channels.delete(channel)
        }
      })
      owned.tail = cleanup
      await cleanup
    }
  }
  async limit(key: string, count: number, seconds: number) {
    await this.connect()
    return Number(await this.command.eval(LIMIT, { keys: [`${this.namespace}:rate:${key}`], arguments: [String(seconds)] })) <= count
  }
  async close() { if (this.command.isOpen) this.command.destroy(); if (this.subscriber.isOpen) this.subscriber.destroy() }
}
