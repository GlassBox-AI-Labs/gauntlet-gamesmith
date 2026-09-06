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
  if (process.env.GAME_ORIGIN) return new URL(process.env.GAME_ORIGIN).origin
  const host = (await headers()).get('host') ?? 'localhost:4310'
  if (!/^[a-zA-Z0-9.\-\[\]:]+$/.test(host)) throw new Error('Invalid host')
  const url = new URL(`http://${host}`)
  url.port = process.env.GAME_PORT ?? '4311'
  return url.origin
}
export function catalogOrigin() {
  return new URL(process.env.CATALOG_ORIGIN ?? 'http://localhost:4310').origin
}

// Next may normalize request.url to localhost when bound to 0.0.0.0.
// Preserve the actual authority for the local desktop/browser handoff.
export function requestOrigin(request: Request) {
  const host = request.headers.get('host')
  if (!host || !/^[a-zA-Z0-9.\-\[\]:]+$/.test(host))
    throw new Error('Invalid request host')
  return new URL(`${new URL(request.url).protocol}//${host}`).origin
}
