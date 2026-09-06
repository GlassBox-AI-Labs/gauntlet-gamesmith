import 'server-only'
import { z } from 'zod'
import { CatalogError } from '@gauntlet/data/errors'
import { publisherForToken } from './auth-user'
import { captureServerError } from './capture'
import { requestOrigin } from './config'
export async function readBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new CatalogError('JSON request required.')
  const reader = request.body?.getReader()
  if (!reader) throw new CatalogError('Request body required.')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > 65536) {
      await reader.cancel()
      throw new CatalogError(
        'Request too large. Publish artifacts directly from a saved round.',
      )
    }
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch (error) {
    captureServerError(error, 'http.invalid-json')
    throw new CatalogError('Invalid JSON request.')
  }
}
export async function requestPublisher(request: Request) {
  const bearer = request.headers.get('authorization')
  if (bearer?.startsWith('Bearer ') && bearer.length <= 12000)
    return publisherForToken(bearer.slice(7))
  throw new CatalogError(
    'Sign in from the desktop to publish a saved round.',
    'unauthorized',
  )
}
export function route(
  context: string,
  fn: (request: Request) => Promise<unknown>,
) {
  return async (request: Request) => {
    try {
      if (
        request.method !== 'GET' &&
        request.headers.get('origin') &&
        request.headers.get('origin') !== requestOrigin(request)
      )
        throw new CatalogError('Cross-origin request denied.', 'unauthorized')
      return Response.json(await fn(request), {
        headers: { 'Cache-Control': 'no-store' },
      })
    } catch (error) {
      captureServerError(error, context)
      const expected =
        error instanceof CatalogError || error instanceof z.ZodError
      const code =
          error instanceof CatalogError ? error.code : 'invalid_request',
        message =
          error instanceof CatalogError
            ? error.message
            : expected
              ? 'Invalid request.'
              : 'Catalog service is unavailable. Try again.'
      return Response.json(
        {
          ok: false,
          code: expected ? code : 'unavailable',
          message,
          error: message,
        },
        {
          status: expected
            ? code === 'unauthorized'
              ? 401
              : code === 'conflict'
                ? 409
                : 400
            : 500,
        },
      )
    }
  }
}
