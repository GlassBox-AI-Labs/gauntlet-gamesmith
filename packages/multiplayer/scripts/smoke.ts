import fs from 'node:fs'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { MultiplayerClient } from '../src/client'
import { PoseBuffer } from '../src/smoothing'

// Supply a private JSON file containing {url: <actual saved-round preview URL>}.
// Never print the URL or capability. This drives the real API/relay, not a UI mock.
const input = process.argv[2]
if (!input) throw new Error('Pass a private preview JSON file.')
const preview = new URL(JSON.parse(fs.readFileSync(input, 'utf8')).url)
const response = await fetch(preview)
assert.equal(response.status, 200, 'preview must be available')
const html = await response.text()
const bootstrap = html.match(/Object\.defineProperty\(window,'gamesmith',\{value:(\{.*?\}),writable:false\}\)/)
assert.ok(bootstrap, 'preview must contain the multiplayer launch capability')
const launch = JSON.parse(bootstrap[1])
const sockets: WebSocket[] = []
class TestSocket extends WebSocket {
  constructor(url: string) { super(url, { handshakeTimeout: 15000 }); sockets.push(this) }
}
Object.assign(globalThis, { WebSocket: TestSocket })
const one = new MultiplayerClient(launch), two = new MultiplayerClient(launch), leaving = new MultiplayerClient(launch)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, timeout = 15000) {
  const end = Date.now() + timeout
  while (!check()) { if (Date.now() > end) throw new Error('Multiplayer smoke timed out'); await delay(50) }
}
let sendTimer: ReturnType<typeof setInterval> | undefined
let heartbeat: ReturnType<typeof setInterval> | undefined
let received = 0, connected = 0, beforeReconnect = 0
const rtt: number[] = [], rendered: number[] = []
const poses = new PoseBuffer()
try {
  const a = await one.join('Protocol One'), b = await two.join('Protocol Two')
  assert.equal(a.id, b.id, 'guests must share a room')
  await leaving.join('Leaving Guest')
  leaving.leave()
  await delay(1200)
  assert.equal((await one.room()).players.length, 2, 'leaving must free the lobby seat')
  const room = await one.room(true)
  await two.room()
  assert.equal(room.endAt! - room.startAt!, 180000, 'server owns the 180-second deadline')
  const playerId = two.session!.playerId
  two.setCondition('unstable')
  two.onChange(() => {
    if (two.diagnostics.status === 'connected') { connected++; rtt.push(two.diagnostics.rttMs) }
  })
  two.onState(s => {
    received++
    poses.push(s.at, s.seq, { x: Number(s.state.x), z: 0, heading: 0, s: Number(s.state.s), vx: 20, vz: 0, speed: 20 }, two.serverNow())
  })
  one.connect(); two.connect()
  await until(() => one.diagnostics.status === 'connected' && two.diagnostics.status === 'connected')
  console.log(JSON.stringify({ step: 'connected', guests: room.players.length, instances: [one.diagnostics.instance, two.diagnostics.instance], sessionSeconds: 180 }))
  sendTimer = setInterval(() => {
    const distance = Math.max(0, one.serverNow() - room.startAt!) / 1000 * 20
    one.publish({ x: distance, z: 0, heading: 0, s: distance, vx: 20, vz: 0, speed: 20 })
    const pose = poses.sample(two.serverNow()); if (pose) rendered.push(pose.x)
  }, 50)
  heartbeat = setInterval(() => console.log(JSON.stringify({ step: 'running', snapshots: received, secondsLeft: Math.max(0, Math.ceil((room.endAt! - two.serverNow()) / 1000)) })), 45000)
  await until(() => received >= 20, 20000)
  beforeReconnect = received
  sockets[1].terminate() // Simulate a real dropped TCP connection, not a game-state edit.
  await until(() => sockets.length >= 3 && two.diagnostics.status === 'connected')
  assert.equal(two.session!.playerId, playerId, 'reconnect must retain the guest identity')
  assert.equal(two.session!.room.endAt, room.endAt, 'reconnect must not extend the deadline')
  await until(() => received > beforeReconnect + 20, 20000)
  console.log(JSON.stringify({ step: 'reconnected', snapshots: received, originalDeadlinePreserved: true }))
  await until(() => one.diagnostics.status === 'ended' && two.diagnostics.status === 'ended', 190000)
  assert.ok(received > 500, `expected sustained relay traffic, received ${received}`)
  const ordered = rtt.filter(n => n > 0).sort((a,b) => a-b)
  const result = { passed: true, sessionSeconds: 180, received, reconnected: sockets.length >= 3, rttMedianMs: ordered[Math.floor(ordered.length/2)], rttP95Ms: ordered[Math.floor(ordered.length*0.95)], renderedSamples: rendered.length, smoothing: poses.diagnostics(), connectedEvents: connected }
  console.log(JSON.stringify(result))
  if (process.env.MULTIPLAYER_SMOKE_RESULT) fs.writeFileSync(process.env.MULTIPLAYER_SMOKE_RESULT, JSON.stringify(result, null, 2))
} finally {
  clearInterval(sendTimer); clearInterval(heartbeat)
  one.leave(); two.leave(); leaving.leave()
  for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
}
