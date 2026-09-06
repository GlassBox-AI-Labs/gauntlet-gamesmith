import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/db')
const project = 'gauntlet-gamesmith'
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
const context = JSON.parse(docker(['context', 'inspect']))[0]
const endpoint = context.Endpoints.docker.Host
if (!endpoint.startsWith('unix://')) throw new Error('Local catalog setup requires a local Docker Unix socket.')
function api(method, route, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: endpoint.slice(7), path: `/v1.47${route}`, method, headers: { 'Content-Type': 'application/json' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
        const text = Buffer.concat(chunks).toString(), result = text ? JSON.parse(text) : null
        if (response.statusCode >= 400) reject(new Error(`Docker operation failed (${response.statusCode}). Local containers were retained for inspection.`))
        else resolve(result)
      })
    }); request.on('error', reject); request.end(body ? JSON.stringify(body) : undefined)
  })
}
console.log('Starting local Supabase. This may download container images on first use…')
try {
  execFileSync('supabase', ['start', '-x', 'studio,imgproxy,edge-runtime,logflare,vector,supavisor', '--output', 'json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 8 * 1024 * 1024 })
} catch {
  throw new Error('Local Supabase did not start. Check Docker Desktop and run supabase status locally for details; captured output is withheld because it can include development keys.')
}
// CLI defaults publish admin/API ports on every interface. Recreate only this
// project's port-publishing containers with identical volumes/config and loopback
// bindings. Do not change Docker daemon defaults or touch other projects.
const ids = docker(['ps', '-aq', '--filter', `label=com.supabase.cli.project=${project}`]).trim().split('\n').filter(Boolean)
for (const id of ids) {
  const info = JSON.parse(docker(['inspect', id]))[0]
  const bindings = info.HostConfig.PortBindings
  if (!bindings || !Object.values(bindings).some(entries => entries?.some(e => e.HostIp !== '127.0.0.1'))) continue
  const name = info.Name.slice(1)
  if (!name.startsWith('supabase_') || !name.endsWith(`_${project}`)) throw new Error('Unexpected project container name.')
  const changed = structuredClone(info.HostConfig)
  for (const entries of Object.values(changed.PortBindings)) for (const entry of entries ?? []) entry.HostIp = '127.0.0.1'
  const networks = Object.fromEntries(Object.entries(info.NetworkSettings.Networks).map(([name, n]) => [name, { Aliases: name === 'bridge' ? undefined : n.Aliases?.filter(alias => alias !== id && alias !== id.slice(0, 12)) }]))
  const retired = `${name}-rebinding-${randomUUID()}`
  let created
  await api('POST', `/containers/${id}/stop?t=10`)
  await api('POST', `/containers/${id}/rename?name=${retired}`)
  try {
    created = await api('POST', `/containers/create?name=${name}`, { ...info.Config, HostConfig: changed, NetworkingConfig: { EndpointsConfig: networks } })
    await api('POST', `/containers/${created.Id}/start`)
  } catch (error) {
    if (created) await api('DELETE', `/containers/${created.Id}?force=true`)
    await api('POST', `/containers/${id}/rename?name=${name}`)
    await api('POST', `/containers/${id}/start`)
    throw error
  }
  await api('DELETE', `/containers/${id}`) // no volume deletion
  console.log(`Restricted ${name} to loopback.`)
}
console.log('Local Supabase started. Backend ports are loopback-only. Run pnpm catalog:dev to expose the catalog and games on your LAN.')
