import http from 'node:http'
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { RedisRoomStore } from '@gauntlet/multiplayer/redis'
import { MultiplayerServer, attachRelay } from '@gauntlet/multiplayer/server'
import { MAX_MESSAGE_BYTES } from '@gauntlet/multiplayer'
const port = Number(process.env.MULTIPLAYER_PORT ?? 4312), instance = randomUUID()
const store = new RedisRoomStore(process.env.MULTIPLAYER_REDIS_URL!, process.env.MULTIPLAYER_NAMESPACE ?? 'gamesmith-local', () => console.error('Local multiplayer Redis disconnected'))
const service = new MultiplayerServer(store, process.env.CATALOG_SECRET!, process.env.MULTIPLAYER_SOCKET_URL ?? `ws://127.0.0.1:${port}`)
const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ service: 'gamesmith-multiplayer', instance })) })
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES })
wss.on('connection', socket => attachRelay(socket, service, { instance, log: event => console.log(event) }))
server.listen(port, '0.0.0.0', () => console.log(`Multiplayer: ${service.socketUrl}`))
process.on('SIGINT', () => { for (const socket of wss.clients) socket.close(1001, 'Preview stopped'); wss.close(); server.close(); void store.close() })
