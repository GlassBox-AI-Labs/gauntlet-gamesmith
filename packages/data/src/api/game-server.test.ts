import { describe, expect, it, vi } from 'vitest'
import { GameServer } from './game-server'
import type { Catalog } from './catalog'

const gameId = '11111111-1111-4111-8111-111111111111'
const releaseId = '22222222-2222-4222-8222-222222222222'
function fixture(data = '<html>Game</html>') {
  const source = {
    game: vi.fn(async () => ({ id: gameId, current_release_id: releaseId })),
    release: vi.fn(async () => ({
      id: releaseId,
      game_id: gameId,
      status: 'ready',
    })),
    artifact: vi.fn(async () => ({
      files: [
        { path: 'index.html', data: Buffer.from(data).toString('base64') },
      ],
    })),
    validPreview: vi.fn((_id: string, token: string) => token === 'valid'),
  }
  const server = new GameServer(source as unknown as Catalog, vi.fn())
  return {
    source,
    request: (
      path = `play/${gameId}/${releaseId}/index.html`,
      method = 'GET',
    ) => server.serve(new Request(`https://games.example/${path}`, { method })),
  }
}
describe('game serving on local and hosted origins', () => {
  it('streams large assets with the sandbox policy and no browser/CDN response cache', async () => {
    const large = 'x'.repeat(5 * 1024 * 1024)
    const { request } = fixture(large)
    const response = await request()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain(
      'sandbox allow-scripts allow-pointer-lock;',
    )
    expect(response.headers.get('content-security-policy')).toContain(
      "connect-src 'none'",
    )
    expect(response.headers.get('content-security-policy')).not.toContain(
      'allow-same-origin',
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.text()).toBe(large)
  })
  it('rechecks publication after cached assets were loaded', async () => {
    const { request, source } = fixture()
    expect((await request()).status).toBe(200)
    source.game.mockResolvedValue({
      id: gameId,
      current_release_id: null,
    } as never)
    expect((await request()).status).toBe(404)
    expect(source.artifact).toHaveBeenCalledTimes(1)
  })
  it('rechecks preview expiry after cached assets were loaded', async () => {
    const { request, source } = fixture()
    expect(
      (await request(`preview/${releaseId}/valid/index.html`)).status,
    ).toBe(200)
    source.validPreview.mockReturnValue(false)
    expect(
      (await request(`preview/${releaseId}/valid/index.html`)).status,
    ).toBe(404)
  })
  it('denies unready releases and paths outside the validated artifact', async () => {
    const { request, source } = fixture()
    expect(
      (await request(`play/${gameId}/${releaseId}/missing.js`)).status,
    ).toBe(404)
    expect(
      (await request(`play/${gameId}/${releaseId}/%2e%2e%2fsecret.txt`)).status,
    ).toBe(404)
    source.release.mockResolvedValue({
      id: releaseId,
      game_id: gameId,
      status: 'failed',
    })
    expect((await request()).status).toBe(404)
  })
  it('has no publisher endpoints and sends no body for HEAD or unsupported methods', async () => {
    const { request } = fixture()
    expect((await request('api/login', 'POST')).status).toBe(405)
    const head = await request(undefined, 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const missing = await request('api/me', 'HEAD')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe('')
  })
})
