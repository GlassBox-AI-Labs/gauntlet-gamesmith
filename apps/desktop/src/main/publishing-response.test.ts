import { describe, expect, it } from 'vitest'
import { readCatalogResponse } from './publishing-response'

describe('publishing API responses', () => {
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
