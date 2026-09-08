import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCatalogResponse, requestCatalog } from './publishing-response'

describe('publishing network requests', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends signup to the selected catalog and parses the API response', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    const init = { method: 'POST', body: JSON.stringify({ password: 'private-password' }) }
    await expect(requestCatalog('https://gauntletgamesmith.com', 'signup', init))
      .resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith('https://gauntletgamesmith.com/api/signup', init)
  })

  it.each([
    ['https://gauntletgamesmith.com', 'Check your internet connection'],
    ['http://127.0.0.1:4310', 'Start the local catalog'],
  ])('explains unreachable %s without exposing credentials or raw errors', async (origin, guidance) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed: private-password')))
    const request = requestCatalog(origin, 'signup', { method: 'POST', body: 'private-password' })
    await expect(request).rejects.toThrow(`Cannot reach the publishing service at ${origin}`)
    await expect(request).rejects.toThrow(guidance)
    await expect(request).rejects.not.toThrow('private-password')
  })

  it('distinguishes timeout and cancellation from network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    for (const [reason, message] of [
      [new DOMException('timeout', 'TimeoutError'), 'took too long'],
      [new Error('private details'), 'Publishing request cancelled'],
    ] as const) {
      await expect(requestCatalog('https://gauntletgamesmith.com', 'signup', {
        signal: AbortSignal.abort(reason),
      })).rejects.toThrow(message)
    }
  })

  it('preserves server validation errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      Response.json({ error: 'Invalid verification code.' }, { status: 401 }),
    ))
    await expect(requestCatalog('https://gauntletgamesmith.com', 'verify-email', {}))
      .rejects.toThrow('Invalid verification code.')
  })
})

describe('publishing API responses', () => {
  it('offers password sign-in when the server does not support sign-in codes', async () => {
    await expect(readCatalogResponse(new Response('Not found', { status: 404 }), 'sign-in-code'))
      .rejects.toThrow('Sign in with your password instead.')
  })
  it.each(['signup', 'verify-email', 'resend-verification'])(
    'explains an older server without exposing its HTML for %s',
    async (route) => {
      const response = new Response('<!DOCTYPE html><h1>not found</h1>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      })
      await expect(readCatalogResponse(response, route)).rejects.toThrow(
        'Account creation is not available',
      )
    },
  )
  it('handles malformed and non-object JSON without exposing the response body', async () => {
    for (const body of ['<!DOCTYPE secret>', 'null', '[]']) {
      await expect(
        readCatalogResponse(
          new Response(body, {
            headers: { 'content-type': 'application/json' },
          }),
          'login',
        ),
      ).rejects.toThrow(
        'The publishing service could not complete this request.',
      )
    }
  })
  it('preserves valid API results and expected errors', async () => {
    await expect(
      readCatalogResponse(Response.json({ publisher: 'name' }), 'me'),
    ).resolves.toEqual({ publisher: 'name' })
    await expect(
      readCatalogResponse(
        Response.json({ error: 'Invalid verification code.' }, { status: 401 }),
        'verify-email',
      ),
    ).rejects.toThrow('Invalid verification code.')
  })
})
