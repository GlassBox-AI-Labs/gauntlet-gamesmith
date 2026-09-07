import { execFileSync } from 'node:child_process'
const name = 'gamesmith-multiplayer-redis'
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let existing
try { existing = JSON.parse(docker(['inspect', name]))[0] } catch (error) {
  if (!String(error.stderr).includes('No such')) throw new Error('Docker is unavailable. Start Docker Desktop and retry.')
}
if (existing) {
  const port = existing.HostConfig.PortBindings?.['6379/tcp']
  if (existing.Config.Image !== 'redis:7-alpine' || !port?.some(binding => binding.HostIp === '127.0.0.1' && binding.HostPort === '56329')) throw new Error('The multiplayer Redis container has unexpected settings; inspect it before reusing it.')
  if (!existing.State.Running) docker(['start', name])
} else docker(['run', '-d', '--name', name, '-p', '127.0.0.1:56329:6379', 'redis:7-alpine', 'redis-server', '--appendonly', 'no', '--save', ''])
if (docker(['exec', name, 'redis-cli', 'ping']).trim() !== 'PONG') throw new Error('Local multiplayer Redis did not start.')
console.log('Local multiplayer Redis is ready on 127.0.0.1:56329. Match state is temporary.')
