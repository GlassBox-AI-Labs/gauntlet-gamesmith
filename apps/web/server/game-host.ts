import http from 'node:http'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { Catalog } from '@gauntlet/data/api/catalog'
import { assetPath, uuid, MIME, type GameArtifact } from '@gauntlet/publishing'
import { captureServerError } from '../src/lib/capture'
const client = createClient<Database>(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)
const catalog = new Catalog(
  client,
  process.env.CATALOG_SECRET!,
  captureServerError,
)
const cache = new Map<string, { artifact: GameArtifact; bytes: number }>()
const loading = new Map<string, Promise<GameArtifact>>()
async function releaseArtifact(
  release: Awaited<ReturnType<Catalog['release']>>,
) {
  const cached = cache.get(release.id)?.artifact
  if (cached) return cached
  const inflight = loading.get(release.id)
  if (inflight) return inflight
  if (loading.size >= 4) throw new Error('Artifact loading capacity reached')
  const pending = catalog
    .artifact(release)
    .then((artifact) => {
      const bytes = artifact.files.reduce(
        (sum, file) => sum + file.data.length,
        0,
      )
      let held = [...cache.values()].reduce(
        (sum, value) => sum + value.bytes,
        0,
      )
      while (held + bytes > 64 * 1024 * 1024 && cache.size) {
        const id = cache.keys().next().value!
        held -= cache.get(id)!.bytes
        cache.delete(id)
      }
      cache.set(release.id, { artifact, bytes })
      return artifact
    })
    .finally(() => loading.delete(release.id))
  loading.set(release.id, pending)
  return pending
}
const games = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const parts = new URL(req.url ?? '/', 'http://local').pathname
      .split('/')
      .slice(1)
    let release, relative: string
    if (parts[0] === 'preview') {
      release = await catalog.release(uuid(parts[1]))
      if (!catalog.validPreview(release.id, parts[2]))
        throw new Error('Preview expired')
      relative = parts.slice(3).join('/') || 'index.html'
    } else if (parts[0] === 'play') {
      const game = await catalog.game(uuid(parts[1]))
      if (!game.current_release_id || game.current_release_id !== parts[2])
        throw new Error('Game unpublished')
      release = await catalog.release(game.current_release_id)
      relative = parts.slice(3).join('/') || 'index.html'
    } else throw new Error('Game not found')
    // Recheck the release pointer above on every request, even for cached artifacts.
    const artifact = await releaseArtifact(release)
    const file = artifact.files.find(
      (f) => f.path === assetPath(decodeURIComponent(relative)),
    )
    if (!file) throw new Error('Asset missing')
    res.writeHead(200, {
      'Content-Type': MIME[file.path.split('.').at(-1)!.toLowerCase()],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Access-Control-Allow-Origin': '*',
      'Content-Security-Policy':
        "sandbox allow-scripts allow-pointer-lock; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'self'",
    })
    res.end(
      req.method === 'HEAD' ? undefined : Buffer.from(file.data, 'base64'),
    )
  } catch (error) {
    captureServerError(error, 'game-host.request')
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify({ error: 'Game unavailable or preview expired.' }))
  }
})
games.requestTimeout = 30000
games.listen(Number(process.env.GAME_PORT ?? 4311), '0.0.0.0', () =>
  console.log(
    `Game host: ${process.env.GAME_ORIGIN ?? 'http://localhost:4311'}`,
  ),
)
process.on('SIGINT', () => games.close())
