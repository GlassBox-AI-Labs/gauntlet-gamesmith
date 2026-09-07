import 'server-only'
import { RedisRoomStore } from '@gauntlet/multiplayer/redis'
import { MultiplayerServer } from '@gauntlet/multiplayer/server'
import { config } from './config'
let server: MultiplayerServer | undefined
export function multiplayerServer() {
  if (!server) {
    const redis = process.env.MULTIPLAYER_REDIS_URL ?? process.env.REDIS_URL ?? process.env.KV_URL
    const socketUrl = process.env.MULTIPLAYER_SOCKET_URL
    if (!redis || !socketUrl) throw new Error('Multiplayer is not configured.')
    server = new MultiplayerServer(new RedisRoomStore(redis, process.env.MULTIPLAYER_NAMESPACE ?? 'gamesmith-production', () => console.error('Multiplayer Redis connection failed')), config().secret, socketUrl)
  }
  return server
}
