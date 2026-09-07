export type State = Record<string, number | boolean | string>
export interface Player { id: string; name: string; slot: number }
export interface Room {
  id: string; scope: string; gameId: string; releaseId: string; seed: number
  players: Player[]; maxPlayers: number; createdAt: number; readyAt: number
  startAt: number | null; endAt: number | null; expiresAt: number
}
export interface Launch { version: 1; apiUrl: string; gameId: string; releaseId: string; previewToken?: string }
export interface Session { room: Room; playerId: string; ticket: string; serverTime: number; socketUrl: string }
export interface Snapshot { type: 'state'; playerId: string; seq: number; at: number; state: State }
export type NetworkCondition = 'local' | 'internet' | 'unstable'
export interface Diagnostics { status: 'lobby' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error'; rttMs: number; snapshotAgeMs: number; instance: string; error: string }
export declare class MultiplayerClient {
  constructor(launch: Launch)
  readonly launch: Launch
  static fromWindow(): MultiplayerClient
  session: Session | null
  readonly diagnostics: Diagnostics
  serverNow(): number
  setCondition(condition: NetworkCondition): void
  onState(handler: (snapshot: Snapshot) => void): () => void
  onChange(handler: () => void): () => void
  join(name: string, roomId?: string): Promise<Room>
  room(start?: boolean): Promise<Room>
  connect(): void
  publish(state: State): void
  leave(): void
}
export interface SnapshotBufferOptions { minDelayMs?: number; maxDelayMs?: number; maxExtrapolateMs?: number }
export interface SnapshotInterpolation<T extends State> {
  interpolate(previous: Readonly<T>, next: Readonly<T>, alpha: number): T
  extrapolate?(state: Readonly<T>, seconds: number): T
  discontinuity?(previous: Readonly<T>, next: Readonly<T>): boolean
}
export declare class SnapshotBuffer<T extends State = State> {
  constructor(interpolation: SnapshotInterpolation<T>, options?: SnapshotBufferOptions)
  push(at: number, seq: number, state: T, arrival: number): void
  sample(serverNow: number): T | null
  diagnostics(): { bufferMs: number; jitterMs: number; samples: number }
}
export type Transform = { x: number; y: number; z: number; vx: number; vy: number; vz: number; qx: number; qy: number; qz: number; qw: number }
export type TransformBufferOptions = SnapshotBufferOptions & { teleportDistance?: number }
export declare class TransformBuffer extends SnapshotBuffer<Transform> {
  constructor(options?: TransformBufferOptions)
}
/** Compatibility adapter for existing track-motion integrations. */
export type Pose = { x: number; z: number; heading: number; s: number; vx: number; vz: number; speed: number }
export declare class PoseBuffer extends SnapshotBuffer<Pose> {
  constructor(options?: TransformBufferOptions)
}
