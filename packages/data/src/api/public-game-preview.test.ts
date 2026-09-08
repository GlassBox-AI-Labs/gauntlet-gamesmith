import { describe, expect, it, vi } from 'vitest'
import { PublicGamePreview } from './public-game-preview'

const path = '/play/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/index.html'
const policy = "sandbox allow-scripts allow-pointer-lock; default-src 'self'; connect-src 'self' https://catalog.example wss://catalog.example; form-action 'none'"
function fixture() {
  const capture = vi.fn()
  const fetcher = vi.fn(async () => new Response('<script>window.gamesmith={version:1}</script>', {
    headers: { 'content-type': 'text/html', 'content-security-policy': policy, 'set-cookie': 'private=value', 'cache-control': 'public, max-age=3600' },
  }))
  const server = new PublicGamePreview('https://games.example', capture, fetcher)
  return { capture, fetcher, server, request: (suffix = path, method = 'GET') => server.serve(new Request('https://preview.example' + suffix, { method, headers: { cookie: 'account=private', authorization: 'Bearer private' } })) }
}
describe('public game preview', () => {
  it('streams published bytes and preserves networking restrictions while enabling form handlers', async () => {
    const { request, fetcher } = fixture()
    const response = await request(path + '?private=discarded')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<script>window.gamesmith={version:1}</script>')
    expect(response.headers.get('content-security-policy')).toBe(policy.replace('allow-pointer-lock;', 'allow-pointer-lock allow-forms;'))
    expect(response.headers.get('content-type')).toBe('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(fetcher).toHaveBeenCalledWith(new URL('https://games.example' + path), {
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal),
    })
  })
  it.each(['/preview/secret/token/index.html', '/api/login', path.replace('index.html', '%2e%2e%2fsecret.txt'), path.replace('index.html', '%2F%2Fevil.example/a.js')])('does not fetch private or invalid paths: %s', async (path) => {
    const { request, fetcher } = fixture()
    expect((await request(path)).status).toBe(404)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('denies mutations and returns bodyless HEAD responses', async () => {
    const { request, fetcher } = fixture()
    expect((await request(path, 'POST')).status).toBe(405)
    expect(fetcher).not.toHaveBeenCalled()
    const response = await request(path, 'HEAD')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(fetcher.mock.calls[0]).toEqual([expect.any(URL), expect.objectContaining({ method: 'HEAD' })])
  })
  it('rechecks publication for every request and never retains unpublished bytes', async () => {
    const { request, fetcher } = fixture()
    expect((await request()).status).toBe(200)
    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }))
    expect((await request()).status).toBe(404)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('fails closed and reports missing isolation headers and upstream failures', async () => {
    const { request, fetcher, capture } = fixture()
    fetcher.mockResolvedValueOnce(new Response('unsafe'))
    expect((await request()).status).toBe(502)
    fetcher.mockRejectedValueOnce(new Error('upstream unavailable'))
    expect((await request()).status).toBe(502)
    expect(capture).toHaveBeenCalledTimes(2)
  })
  it('rejects invalid upstream origins and recursive proxying', async () => {
    for (const origin of ['http://games.example', 'https://user:password@games.example', 'https://games.example/path', 'https://games.example?query'])
      expect(() => new PublicGamePreview(origin, vi.fn())).toThrow()
    const { server, fetcher } = fixture()
    expect((await server.serve(new Request('https://games.example' + path))).status).toBe(404)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
