import { describe, expect, it, vi, afterEach } from 'vitest'
import { MultiplayerServer, roomScope, type RoomStore } from './server'
import { clientMessage, type State } from './index'
const secret = 'a'.repeat(64)
afterEach(() => vi.useRealTimers())
describe('guest capabilities', () => {
  it('rejects modified, expired, and cross-environment tickets', () => {
    const server = new MultiplayerServer({} as RoomStore, secret, 'wss://example.com/socket')
    const claims = { scope: roomScope(secret, 'game', 'release', false), roomId: '11111111-1111-4111-8111-111111111111', playerId: '22222222-2222-4222-8222-222222222222', expiresAt: Date.now()+1000 }
    const ticket = server.ticket(claims)
    expect(server.verify(ticket)).toEqual(claims)
    expect(() => server.verify(ticket+'x')).toThrow()
    expect(() => new MultiplayerServer({} as RoomStore, 'b'.repeat(64), '').verify(ticket)).toThrow()
    vi.useFakeTimers();vi.setSystemTime(claims.expiresAt+1)
    expect(() => server.verify(ticket)).toThrow('ended')
  })
  it('isolates game, release, and preview scopes', () => {
    const scopes = [roomScope(secret,'g1','r1',false),roomScope(secret,'g2','r1',false),roomScope(secret,'g1','r2',false),roomScope(secret,'g1','r1',true)]
    expect(new Set(scopes).size).toBe(4)
  })
})

it.each<State>([
  { x: 2, y: 12, z: -4, animation: 'gliding', region: 'forest' },
  { tile: 4, switchOn: true, revision: 2, puzzle: 'bridge' },
  { emote: 'wave', ready: true },
])('accepts game-defined state without a vehicle or spatial schema: %j', state => {
  const message = { type: 'state', seq: 1, at: Date.now(), state }
  expect(clientMessage.parse(message)).toEqual(message)
})
