import { z } from 'zod'

export const SESSION_MS = 180_000
export const LOBBY_MS = 30_000
export const COUNTDOWN_MS = 4_000
export const ROOM_LIFETIME_MS = 270_000
export const MAX_PLAYERS = 6
export const MAX_MESSAGE_BYTES = 4096
export const UPDATE_INTERVAL_MS = 40
export const MANIFEST_FILE = 'gamesmith.multiplayer.json'
export const multiplayerManifest = z.object({ version: z.literal(1), mode: z.literal('relay'), maxPlayers: z.number().int().min(2).max(MAX_PLAYERS).default(MAX_PLAYERS), sessionSeconds: z.literal(180).default(180) }).strict()
export type MultiplayerManifest = z.infer<typeof multiplayerManifest>
export const identity = z.string().uuid()
export const joinInput = z.object({ gameId: identity, releaseId: identity, name: z.string().trim().min(1).max(24), roomId: identity.optional(), previewToken: z.string().max(1000).optional() }).strict()
export type JoinInput = z.infer<typeof joinInput>
export interface Player { id: string; name: string; slot: number }
export interface Room {
  id: string; scope: string; gameId: string; releaseId: string; seed: number
  players: Player[]; maxPlayers: number; createdAt: number; readyAt: number
  startAt: number | null; endAt: number | null; expiresAt: number
}
export interface Session { room: Room; playerId: string; ticket: string; serverTime: number; socketUrl: string }
export interface Launch { version: 1; apiUrl: string; gameId: string; releaseId: string; previewToken?: string }
export const launchSchema = z.object({ version: z.literal(1), apiUrl: z.string().url(), gameId: identity, releaseId: identity, previewToken: z.string().optional() }).strict()
export type State = Record<string, number | boolean | string>
const stateValue = z.union([z.number().finite().min(-1e9).max(1e9), z.boolean(), z.string().max(100)])
const stateSchema = z.record(z.string().max(40), stateValue).refine(v => Object.keys(v).length <= 32)
export const roomSchema = z.object({
  id: identity, scope: z.string().regex(/^[a-f0-9]{32}$/), gameId: identity, releaseId: identity,
  seed: z.number().int(), players: z.array(z.object({ id: identity, name: z.string().max(24), slot: z.number().int().min(0).max(MAX_PLAYERS - 1) })).max(MAX_PLAYERS),
  maxPlayers: z.number().int().min(2).max(MAX_PLAYERS), createdAt: z.number().finite(), readyAt: z.number().finite(), startAt: z.number().finite().nullable(), endAt: z.number().finite().nullable(), expiresAt: z.number().finite(),
})
export const sessionSchema = z.object({ room: roomSchema, playerId: identity, ticket: z.string().max(3000), serverTime: z.number().finite(), socketUrl: z.string().url().refine(url => /^wss?:/.test(url)) })
export const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), ticket: z.string().max(3000) }).strict(),
  z.object({ type: z.literal('ping'), time: z.number().finite() }).strict(),
  z.object({ type: z.literal('state'), seq: z.number().int().nonnegative().max(1e12), at: z.number().finite(), state: stateSchema }).strict(),
])
export const serverMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), playerId: identity, seq: z.number().int().nonnegative().max(1e12), at: z.number().finite(), state: stateSchema }),
  z.object({ type: z.literal('welcome'), room: roomSchema, playerId: identity, serverTime: z.number().finite(), instance: z.string().max(100) }),
  z.object({ type: z.literal('pong'), time: z.number().finite(), serverTime: z.number().finite() }),
  z.object({ type: z.literal('ended'), serverTime: z.number().finite() }),
  z.object({ type: z.literal('error'), message: z.string().max(500) }),
])
export interface Snapshot { type: 'state'; playerId: string; seq: number; at: number; state: State }
export type ServerMessage = Snapshot | { type: 'welcome'; room: Room; playerId: string; serverTime: number; instance: string } | { type: 'pong'; time: number; serverTime: number } | { type: 'ended'; serverTime: number } | { type: 'error'; message: string }
