import 'server-only'
import { headers } from 'next/headers'
export function config() {
  const url = process.env.SUPABASE_URL,
    anon = process.env.SUPABASE_ANON_KEY,
    key = process.env.SUPABASE_SERVICE_ROLE_KEY,
    secret = process.env.CATALOG_SECRET
  if (!url || !anon || !key || !secret)
    throw new Error(
      'Configure Supabase and CATALOG_SECRET before starting the catalog.',
    )
  return { url, anon, key, secret }
}
export async function gameOrigin() {
  if (process.env.GAME_ORIGIN) {
    const url = new URL(process.env.GAME_ORIGIN)
    if (process.env.VERCEL && url.protocol !== 'https:')
      throw new Error('Hosted games require HTTPS.')
    if (url.host === (await headers()).get('host'))
      throw new Error('Games require a separate origin.')
    return url.origin
  }
  if (process.env.VERCEL) throw new Error('GAME_ORIGIN is required on Vercel.')
  const host = (await headers()).get('host') ?? 'localhost:4310'
  if (!/^[a-zA-Z0-9.\-\[\]:]+$/.test(host)) throw new Error('Invalid host')
  const url = new URL(`http://${host}`)
  url.port = process.env.GAME_PORT ?? '4311'
  return url.origin
}
// Next may normalize request.url to localhost when bound to 0.0.0.0.
// Preserve the actual authority for local request-origin checks.
export function requestOrigin(request: Request) {
  const host = request.headers.get('host')
  if (!host || !/^[a-zA-Z0-9.\-\[\]:]+$/.test(host))
    throw new Error('Invalid request host')
  return new URL(`${new URL(request.url).protocol}//${host}`).origin
}
