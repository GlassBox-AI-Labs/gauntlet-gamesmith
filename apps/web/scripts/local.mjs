import { spawn } from 'node:child_process'
import { localEnvironment } from './environment.mjs'
const env = localEnvironment(),
  mode = process.argv[2] ?? 'dev'
env.MULTIPLAYER_REDIS_URL ??= 'redis://127.0.0.1:56329'
env.MULTIPLAYER_NAMESPACE ??= 'gamesmith-local'
const host = env.CATALOG_HOST ?? '127.0.0.1'
env.GAME_ORIGIN ??= `http://${host}:${env.GAME_PORT ?? '4311'}`
env.MULTIPLAYER_SOCKET_URL ??= `ws://${host}:${env.MULTIPLAYER_PORT ?? '4312'}`
env.MULTIPLAYER_API_ORIGIN ??= `http://${host}:${env.CATALOG_PORT ?? '4310'}`
const children = [
  spawn(
    'next',
    [mode, '--hostname', '0.0.0.0', '--port', env.CATALOG_PORT ?? '4310'],
    { env, stdio: 'inherit' },
  ),
  spawn('tsx', ['server/game-host.ts'], { env, stdio: 'inherit' }),
  spawn('tsx', ['server/multiplayer-host.ts'], { env, stdio: 'inherit' }),
]
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGINT')
}
for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message)
    process.exitCode = 1
    stop()
  })
  child.on('exit', (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1
      stop()
    }
  })
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
