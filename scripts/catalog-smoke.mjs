import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    catalog: { type: 'string' },
    games: { type: 'string' },
  },
})
function origin(input) {
  const url = new URL(input)
  assert(!url.username && !url.password, 'URLs must not contain credentials')
  assert(
    url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname)),
    'Use HTTPS or loopback',
  )
  return url.origin
}
const catalog = origin(values.catalog),
  games = origin(values.games)
assert.notEqual(catalog, games, 'Games require a separate origin')
async function get(url, options) {
  const result = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  })
  assert.equal(
    result.headers.get('set-cookie'),
    null,
    'Public requests must not set account cookies',
  )
  return result
}
assert.equal((await get(catalog)).status, 200)
assert.equal((await get(`${catalog}/api/health`)).status, 200)
assert.equal((await get(games)).status, 200)
assert.equal((await get(`${catalog}/api/me`)).status, 401)
for (const path of ['/login', '/dashboard', '/connect'])
  assert.equal((await get(catalog + path)).status, 404)
assert.equal((await get(`${games}/api/login`, { method: 'POST' })).status, 405)
const listing = await get(`${catalog}/api/games`)
assert.equal(listing.status, 200)
const published = await listing.json()
assert(Array.isArray(published))
for (const game of published) {
  assert.equal(
    (await get(`${catalog}/games/${encodeURIComponent(game.slug)}`)).status,
    200,
  )
  const response = await get(
    `${games}/play/${game.id}/${game.current_release_id}/index.html`,
    { method: 'HEAD' },
  )
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/html/)
  assert.match(
    response.headers.get('content-security-policy'),
    /sandbox allow-scripts allow-pointer-lock;/,
  )
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  console.log(`PASS public game: ${game.slug}`)
}
console.log(
  `PASS catalog, origin isolation, guest access, and ${published.length} published games. This check makes no database writes.`,
)
