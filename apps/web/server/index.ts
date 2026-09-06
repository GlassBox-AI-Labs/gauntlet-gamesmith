import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { createServer as createViteServer } from 'vite'
import { assetPath, boundedText, MAX_WIRE_BYTES, MIME, object, uuid } from '@gauntlet/publishing'
import { Catalog } from './catalog'
import { localConfig, repoRoot, Supabase } from './supabase'

const db = new Supabase(localConfig()), catalog = new Catalog(db)
const recovered = await catalog.recoverUploads()
if (recovered) console.log(`Recovered ${recovered} interrupted publication(s).`)
const port = Number(process.env.CATALOG_PORT ?? 4310), gamePort = Number(process.env.GAME_PORT ?? 4311)
const host = process.env.CATALOG_HOST ?? '0.0.0.0'
const vite = process.argv.includes('--production') ? null : await createViteServer({ root: path.join(repoRoot, 'apps/web'), server: { middlewareMode: true, hmr: false }, appType: 'spa' })
const pairs = new Map<string, { secret: string; expires: number; session?: any }>()
const hash = (s: string): string => createHash('sha256').update(s).digest('hex')
setInterval(() => { for (const [id, pair] of pairs) if (pair.expires < Date.now()) pairs.delete(id) }, 30000).unref()

function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)) }
async function body(req: IncomingMessage, limit = MAX_WIRE_BYTES): Promise<any> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON request required.')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request exceeds upload limit.'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
function token(req: IncomingMessage): string {
  const value = req.headers.authorization
  if (!value?.startsWith('Bearer ') || value.length > 12000) throw new Error('Sign in required.')
  return value.slice(7)
}
function origin(req: IncomingMessage, game = false): string {
  const configured = game ? process.env.GAME_ORIGIN : process.env.CATALOG_ORIGIN
  if (configured) return new URL(configured).origin
  const supplied = req.headers.host ?? `127.0.0.1:${port}`
  if (!/^[a-zA-Z0-9.\-\[\]:]+$/.test(supplied)) throw new Error('Invalid host.')
  const url = new URL(`http://${supplied}`); if (game) url.port = String(gamePort)
  return url.origin
}
async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== origin(req)) throw new Error('Cross-origin request denied.')
  const route = url.pathname
  if (route === '/api/health') { json(res, 200, { ok: true }); return }
  if (route === '/api/games' && req.method === 'GET') { json(res, 200, await catalog.publicGames()); return }
  if (route === '/api/login' && req.method === 'POST') {
    const input = object(await body(req, 16384))
    const session = await db.request('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: boundedText(input.email, 'email', 254), password: boundedText(input.password, 'password', 200) }) }, db.config.anon)
    await db.publisher(session.access_token)
    json(res, 200, session); return
  }
  if (route === '/api/refresh' && req.method === 'POST') {
    const input = object(await body(req, 16384))
    const session = await db.request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: boundedText(input.refreshToken, 'refresh token', 12000) }) }, db.config.anon)
    await db.publisher(session.access_token); json(res, 200, session); return
  }
  if (route === '/api/device/start' && req.method === 'POST') {
    if (pairs.size >= 100) throw new Error('Too many pending sign-ins. Try again shortly.')
    const input = object(await body(req, 16384)), secret = boundedText(input.challenge, 'challenge', 64)
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid challenge.')
    const code = randomBytes(5).toString('hex'); pairs.set(code, { secret, expires: Date.now() + 300000 })
    json(res, 200, { code, url: `${origin(req)}/connect?code=${code}` }); return
  }
  if (route === '/api/device/poll' && req.method === 'POST') {
    const input = object(await body(req, 16384)), code = boundedText(input.code, 'code', 20), pair = pairs.get(code)
    if (!pair || pair.expires < Date.now() || hash(boundedText(input.secret, 'secret', 128)) !== pair.secret) throw new Error('Sign-in expired. Start again.')
    if (!pair.session) { json(res, 200, { pending: true }); return }
    pairs.delete(code); json(res, 200, pair.session); return
  }
  const publisher = await db.publisher(token(req))
  if (route === '/api/device/approve' && req.method === 'POST') {
    const input = object(await body(req, 16384)), pair = pairs.get(boundedText(input.code, 'code', 20))
    if (!pair || pair.expires < Date.now() || pair.session) throw new Error('Sign-in expired or already approved.')
    // Transfer only this explicitly approved session to the initiating desktop challenge.
    const transferred = await db.request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: boundedText(input.refreshToken, 'refresh token', 12000) }) }, db.config.anon)
    if ((await db.publisher(transferred.access_token)).id !== publisher.id) throw new Error('Session belongs to another account.')
    pair.session = { access_token: transferred.access_token, refresh_token: transferred.refresh_token }
    json(res, 200, { ok: true }); return
  }
  if (route === '/api/me') {
    const games = await db.table('games', `?publisher_id=eq.${publisher.id}&order=created_at.desc`)
    const releases = games.length ? await db.table('releases', `?game_id=in.(${games.map((g: any) => uuid(g.id)).join(',')})&order=created_at.desc`) : []
    json(res, 200, { publisher, games, releases }); return
  }
  if (route === '/api/releases' && req.method === 'POST') {
    const input = await body(req)
    json(res, 200, await catalog.upload(publisher.id, input)); return
  }
  if (route === '/api/promote' && req.method === 'POST') {
    const input = object(await body(req, 16384))
    json(res, 200, await catalog.promote(publisher.id, uuid(input.gameId), input.releaseId === null ? null : uuid(input.releaseId), input.generation)); return
  }
  if (route === '/api/preview' && req.method === 'POST') {
    const input = object(await body(req, 16384)), release = await catalog.release(uuid(input.releaseId))
    await catalog.owned(publisher.id, release.game_id)
    if (release.status !== 'ready') throw new Error('Release is not ready.')
    json(res, 200, { url: `${origin(req, true)}/preview/${release.id}/${catalog.previewToken(release.id)}/index.html` }); return
  }
  json(res, 404, { error: 'Not found.' })
}

const app = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://local')
    if (url.pathname.startsWith('/api/')) { await api(req, res, url); return }
    if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed.' }); return }
    if (vite) { vite.middlewares(req, res); return }
    const file = url.pathname.startsWith('/assets/') ? path.join(repoRoot, 'apps/web/build', assetPath(url.pathname.slice(1))) : path.join(repoRoot, 'apps/web/build/index.html')
    res.setHeader('Content-Type', MIME[file.split('.').at(-1)!] ?? 'text/html'); res.end(await fs.readFile(file))
  } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : 'Request failed.' }) }
})
const games = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new Error('Method not allowed.')
    const url = new URL(req.url ?? '/', 'http://local'), parts = url.pathname.split('/').slice(1)
    let release, relative: string
    if (parts[0] === 'preview') {
      release = await catalog.release(uuid(parts[1]))
      if (!catalog.validPreview(release.id, parts[2])) throw new Error('Preview expired or unauthorized.')
      relative = parts.slice(3).join('/') || 'index.html'
    } else if (parts[0] === 'play') {
      const game = await catalog.game(uuid(parts[1]))
      if (!game.current_release_id || game.current_release_id !== parts[2]) throw new Error('This release is not currently published.')
      release = await catalog.release(game.current_release_id); relative = parts.slice(3).join('/') || 'index.html'
    } else throw new Error('Game not found.')
    const file = (await catalog.artifact(release)).files.find(f => f.path === assetPath(decodeURIComponent(relative)))
    if (!file) throw new Error('Game asset not found. Publish a build with relative asset paths.')
    res.writeHead(200, { 'Content-Type': MIME[file.path.split('.').at(-1)!.toLowerCase()], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Access-Control-Allow-Origin': '*', 'Content-Security-Policy': "sandbox allow-scripts allow-pointer-lock; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'self'" })
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(file.data, 'base64'))
  } catch (error) { json(res, 404, { error: error instanceof Error ? error.message : 'Game unavailable.' }) }
})
app.requestTimeout = 120000; games.requestTimeout = 30000
app.listen(port, host, () => console.log(`Catalog: http://localhost:${port}`))
games.listen(gamePort, host, () => console.log(`Game content: http://localhost:${gamePort}`))
process.on('SIGINT', () => { app.close(); games.close(); void vite?.close(); process.exitCode = 0 })
