import { MANIFEST_FILE, multiplayerManifest } from '@glassbox/multiplayer'
import { assetPath, uuid, MIME, GAME_FRAME_SANDBOX, type GameArtifact } from '@gauntlet/publishing'
import type { Catalog } from './catalog'
import type { Capture } from '../errors'
import { gameAssetResponse } from './game-asset-urls'
export { PublicGamePreview } from './public-game-preview'

type Source = Pick<Catalog, 'game' | 'release' | 'artifact' | 'validPreview'>
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Access-Control-Allow-Origin': '*',
  'Content-Security-Policy':
    `sandbox ${GAME_FRAME_SANDBOX}; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'self'`,
}

/** Shared local/hosted serving policy. Cached bytes never bypass access checks. */
export class GameServer {
  private cache = new Map<string, { artifact: GameArtifact; bytes: number }>()
  private loading = new Map<string, Promise<GameArtifact>>()
  constructor(
    private catalog: Source,
    private capture: Capture,
    private multiplayer?: { apiOrigin: string; socketUrl: string },
  ) {}

  private async artifact(release: Awaited<ReturnType<Source['release']>>) {
    const cached = this.cache.get(release.id)?.artifact
    if (cached) return cached
    const inflight = this.loading.get(release.id)
    if (inflight) return inflight
    if (this.loading.size >= 4)
      throw new Error('Artifact loading capacity reached')
    const pending = this.catalog
      .artifact(release)
      .then((artifact) => {
        const bytes = artifact.files.reduce(
          (sum, file) => sum + file.data.length,
          0,
        )
        let held = [...this.cache.values()].reduce(
          (sum, value) => sum + value.bytes,
          0,
        )
        while (held + bytes > 64 * 1024 * 1024 && this.cache.size) {
          const id = this.cache.keys().next().value!
          held -= this.cache.get(id)!.bytes
          this.cache.delete(id)
        }
        this.cache.set(release.id, { artifact, bytes })
        return artifact
      })
      .finally(() => this.loading.delete(release.id))
    this.loading.set(release.id, pending)
    return pending
  }

  async serve(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, {
        status: 405,
        headers: { ...headers, Allow: 'GET, HEAD' },
      })
    try {
      const parts = new URL(request.url).pathname.split('/').slice(1)
      let release, relative: string
      if (parts[0] === 'preview') {
        const id = uuid(parts[1])
        if (!this.catalog.validPreview(id, parts[2] ?? ''))
          throw new Error('Preview expired')
        release = await this.catalog.release(id)
        relative = parts.slice(3).join('/') || 'index.html'
      } else if (parts[0] === 'play') {
        const game = await this.catalog.game(uuid(parts[1]))
        if (
          !game.current_release_id ||
          game.current_release_id !== uuid(parts[2])
        )
          throw new Error('Game unpublished')
        release = await this.catalog.release(game.current_release_id)
        if (release.game_id !== game.id)
          throw new Error('Release ownership mismatch')
        relative = parts.slice(3).join('/') || 'index.html'
      } else throw new Error('Game not found')
      if (release.status !== 'ready') throw new Error('Release not ready')
      const path = assetPath(decodeURIComponent(relative))
      const artifact = await this.artifact(release)
      const file = artifact.files.find((entry) => entry.path === path)
      if (!file) throw new Error('Asset missing')
      let bytes = gameAssetResponse(artifact, path, `/${parts.slice(0, 3).join('/')}/`)
      const responseHeaders = { ...headers }
      const capability = artifact.files.find(entry => entry.path === MANIFEST_FILE)
      if (capability && path.endsWith('.html')) {
        if (!this.multiplayer) throw new Error('Multiplayer is not configured on the game host.')
        if (capability.data.length > 4096) throw new Error('Invalid multiplayer declaration.')
        multiplayerManifest.parse(JSON.parse(Buffer.from(capability.data, 'base64').toString('utf8')))
        const api = new URL(this.multiplayer.apiOrigin), socket = new URL(this.multiplayer.socketUrl)
        if (!['https:', 'http:'].includes(api.protocol) || !['wss:', 'ws:'].includes(socket.protocol)) throw new Error('Invalid multiplayer endpoint.')
        const launch = { version: 1, apiUrl: `${api.origin}/api/multiplayer`, gameId: release.game_id, releaseId: release.id, ...(parts[0] === 'preview' ? { previewToken: parts[2] } : {}) }
        const json = JSON.stringify(launch).replace(/</g, '\\u003c')
        const script = `<script>Object.defineProperty(window,'gamesmith',{value:${json},writable:false});</script>`
        const html = bytes.toString('utf8')
        bytes = Buffer.from(/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, head => head + script) : script + html)
        responseHeaders['Content-Security-Policy'] = headers['Content-Security-Policy'].replace("connect-src 'self'", `connect-src 'self' ${api.origin} ${socket.origin}`)
      }
      // Stream responses so large assets do not use Vercel's buffered payload path.
      const body =
        request.method === 'HEAD'
          ? null
          : new Blob([bytes]).stream()
      return new Response(body, {
        headers: {
          ...responseHeaders,
          'Content-Type': MIME[path.split('.').at(-1)!.toLowerCase()],
        },
      })
    } catch (error) {
      this.capture(error, 'game-server.request')
      return new Response(
        request.method === 'HEAD'
          ? null
          : 'Game unavailable or preview expired.',
        {
          status: 404,
          headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
        },
      )
    }
  }
}
