import { assetPath, GAME_FRAME_SANDBOX, uuid } from '@gauntlet/publishing'
import type { Capture } from '../errors'

/** Public release bytes only; no database, private previews, or forwarded credentials. */
export class PublicGamePreview {
  private origin: string

  constructor(origin: string, private capture: Capture, private request: typeof fetch = fetch) {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('Public game preview upstream must be an HTTPS origin.')
    this.origin = url.origin
  }

  async serve(request: Request): Promise<Response> {
    const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } })
    let target: URL
    try {
      const url = new URL(request.url)
      if (url.origin === this.origin) throw new Error('Preview requires a separate upstream origin.')
      const parts = url.pathname.split('/').slice(1)
      if (parts[0] !== 'play') throw new Error('Only published games are available.')
      const game = uuid(parts[1]), release = uuid(parts[2])
      const asset = assetPath(decodeURIComponent(parts.slice(3).join('/') || 'index.html'))
      target = new URL(`/play/${game}/${release}/${asset.split('/').map(encodeURIComponent).join('/')}`, this.origin)
    } catch {
      return new Response(null, { status: 404, headers })
    }
    try {
      const upstream = await this.request(target, {
        method: request.method, credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      })
      if (upstream.status !== 200) {
        await upstream.body?.cancel()
        return new Response(null, { status: 404, headers })
      }
      // Keep the upstream network allowlist/bootstrap and all its other restrictions.
      // Only form-event dispatch differs from the already-public game response.
      const directives = (upstream.headers.get('content-security-policy') ?? '').split(';').map(value => value.trim())
      const sandbox = directives.filter(value => /^sandbox(?:\s|$)/.test(value))
      if (sandbox.length !== 1 || !directives.includes("form-action 'none'")) {
        await upstream.body?.cancel()
        throw new Error('Public upstream omitted the required game isolation policy.')
      }
      const policy = directives.map(value => value === sandbox[0] ? `sandbox ${GAME_FRAME_SANDBOX}` : value).join('; ')
      return new Response(request.method === 'HEAD' ? null : upstream.body, {
        headers: { ...headers, 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'Content-Security-Policy': policy },
      })
    } catch (error) {
      this.capture(error, 'public-game-preview.request')
      return new Response(null, { status: 502, headers })
    }
  }
}
