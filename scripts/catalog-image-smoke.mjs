// Run against a catalog with published covers (real data or an HTTP fixture backend).
// node scripts/catalog-image-smoke.mjs --catalog http://127.0.0.1:4310
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { catalog: { type: 'string' } } })
const catalog = new URL(values.catalog)
assert(!catalog.username && !catalog.password, 'Do not put credentials in URLs')
async function get(path, headers) {
  const response = await fetch(new URL(path, catalog), {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  })
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`)
  return response
}
function images(html) {
  return [...html.matchAll(/<img\b[^>]*>/g)].map(([tag]) =>
    Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(
      ([, name, value]) => [name.toLowerCase(), value.replaceAll('&amp;', '&')],
    )),
  )
}
function covers(html) {
  return images(html).filter((img) => !img.src?.includes('app-logo'))
}
function checkImage(img) {
  assert(img.src.startsWith('/_next/image?'), `Original cover bypasses optimization: ${img.src}`)
  assert(img.srcset && img.sizes, 'Cover needs responsive candidates and sizes')
  assert.equal(img.loading, 'lazy', 'Covers must remain lazy loaded')
}
const games = await (await get('/api/games')).json()
const withCovers = games.filter((game) => game.cover_key || game.listing.coverPath)
assert(withCovers.length, 'Seed at least one published cover before checking images')
const grid = covers(await (await get('/')).text())
assert.equal(grid.length, withCovers.length)
grid.forEach(checkImage)
for (const handle of new Set(games.map((game) => game.publisher.handle))) {
  const publisher = covers(await (await get(`/publishers/${encodeURIComponent(handle)}`)).text())
  assert.equal(publisher.length, withCovers.filter((game) => game.publisher.handle === handle).length)
  publisher.forEach(checkImage)
}
for (const game of games) {
  const html = await (await get(`/games/${encodeURIComponent(game.slug)}`)).text()
  const detail = covers(html)
  assert.equal(detail.length, game.cover_key || game.listing.coverPath ? 1 : 0)
  detail.forEach(checkImage)
  const poster = html.match(/<div data-testid="game-poster"[^>]*>([\s\S]*?)<\/div>/)
  assert(poster, 'Detail needs an idle player')
  assert.equal(covers(poster[1]).length, detail.length, 'Cover must be inside the player')
  assert(!html.includes('<iframe'), 'Game must not load before Play')
  if (detail.length) {
    const source = new URL(detail[0].src, catalog).searchParams.get('url')
    const card = grid.find((img) => new URL(img.src, catalog).searchParams.get('url')?.includes(`/${game.id}/`))
    assert(card, 'Game needs a catalog cover')
    assert.equal(source, new URL(card.src, catalog).searchParams.get('url'), 'Player must use the same cover as its card')
  }
}
for (const img of grid) {
  const optimized = new URL(img.src, catalog)
  const original = optimized.searchParams.get('url')
  const source = await (await get(original)).arrayBuffer()
  for (const width of [384, 828]) {
    optimized.searchParams.set('w', String(width))
    const response = await get(optimized, { Accept: 'image/webp' })
    assert.match(response.headers.get('content-type'), /^image\/webp\b/)
    const bytes = (await response.arrayBuffer()).byteLength
    if (source.byteLength > 1_000_000)
      assert(bytes < source.byteLength / 4, 'Large cover should shrink by at least 75%')
    console.log(`${original}: ${source.byteLength} → ${bytes} bytes at ${width}px`)
  }
}
for (const source of ['https://example.com/cover.png', 'https://glassbox-games.vercel.app/preview/private/cover.png']) {
  const url = new URL('/_next/image', catalog)
  url.search = new URLSearchParams({ url: source, w: '384', q: '75' }).toString()
  assert.equal((await fetch(url)).status, 400, 'Unapproved image sources must be rejected')
}
console.log('PASS responsive catalog/publisher/detail covers, WebP delivery, size reduction, and source restrictions')
