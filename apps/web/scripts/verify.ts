/** Explicit local integration check: provisions temporary accounts in this project's local Supabase. */
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { Supabase, localConfig } from '../server/supabase'
import { digest } from '@gauntlet/publishing/node'
import { Catalog } from '../server/catalog'
const config = localConfig()
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(config.url)) throw new Error('Integration verification requires local Supabase.')
const db = new Supabase(config), base = process.env.CATALOG_TEST_URL ?? 'http://127.0.0.1:4310'
const users: string[] = [], gameId = randomUUID(), releaseIds: string[] = []
async function request(route: string, value?: unknown, token?: string) {
  const r = await fetch(`${base}/api/${route}`, { method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: value === undefined ? undefined : JSON.stringify(value) })
  return { status: r.status, data: await r.json() }
}
const artifact = (content: string) => ({ version: 1, sourceRevision: 'integration-fixture', files: [{ path: 'index.html', data: Buffer.from(content).toString('base64'), sha256: digest(content) }] })
try {
  async function account() {
    const id = randomUUID(), email = `verify-${id}@local.test`, password = randomBytes(24).toString('hex')
    const user = await db.request('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) }); users.push(user.id)
    await db.table('publishers', '', { method: 'POST', body: JSON.stringify({ id: user.id, handle: `verify-${id}`, display_name: 'Verification publisher' }) })
    const login = await request('login', { email, password }); assert.equal(login.status, 200, login.data.error)
    return login.data
  }
  const owner = await account(), other = await account()
  const metadata = { title: 'Integration game', slug: `verify-${gameId}`, description: 'Local verification', controls: 'None', coverPath: null }
  const input = { gameId, requestKey: randomUUID(), listing: metadata, artifact: artifact('<h1>Version one</h1>') }
  assert.notEqual((await request('releases', input)).status, 200, 'guest cannot upload')
  const uploaded = await request('releases', input, owner.access_token); assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data)); releaseIds.push(uploaded.data.id)
  await db.table('releases', `?id=eq.${uploaded.data.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'uploading' }) })
  await new Catalog(db).recoverUploads()
  assert.equal((await db.table('releases', `?id=eq.${uploaded.data.id}`))[0].status, 'ready', 'restart recovers complete uploaded bytes')
  const missingId = randomUUID(); releaseIds.push(missingId)
  await db.table('releases', '', { method: 'POST', body: JSON.stringify({ id: missingId, game_id: gameId, request_key: randomUUID(), digest: '0'.repeat(64), listing: metadata, base_generation: 0 }) })
  await new Catalog(db).recoverUploads()
  assert.equal((await db.table('releases', `?id=eq.${missingId}`))[0].status, 'failed', 'restart gives incomplete upload a retryable terminal state')
  assert.equal((await request('releases', input, owner.access_token)).data.id, uploaded.data.id, 'retry is idempotent')
  assert.notEqual((await request('releases', { ...input, artifact: artifact('changed') }, owner.access_token)).status, 200, 'retry cannot change bytes')
  assert.notEqual((await request('releases', { ...input, requestKey: randomUUID() }, other.access_token)).status, 200, 'another owner cannot upload')
  assert.notEqual((await request('preview', { releaseId: uploaded.data.id }, other.access_token)).status, 200, 'another owner cannot preview')
  const preview = await request('preview', { releaseId: uploaded.data.id }, owner.access_token); assert.equal(preview.status, 200)
  const page = await fetch(preview.data.url); assert.equal(page.status, 200); assert.match(await page.text(), /Version one/)
  assert.match(page.headers.get('content-security-policy')!, /sandbox/)
  assert.equal((await fetch(preview.data.url.replace(/\/\d{10}\.[a-f0-9]{64}\//, '/invalid/'))).status, 404)
  const promote = { gameId, releaseId: uploaded.data.id, generation: 0 }
  assert.notEqual((await request('promote', promote, other.access_token)).status, 200)
  assert.equal((await request('promote', promote, owner.access_token)).status, 200)
  assert.notEqual((await request('promote', promote, owner.access_token)).status, 200, 'stale promotion fails')
  assert((await request('games')).data.some((g: any) => g.id === gameId))
  const publishedURL = new URL(preview.data.url); publishedURL.pathname = `/play/${gameId}/${uploaded.data.id}/index.html`
  assert.equal((await fetch(publishedURL)).status, 200)
  const bad = { ...input, requestKey: randomUUID(), artifact: { ...input.artifact, files: [{ ...input.artifact.files[0], sha256: '0'.repeat(64) }] } }
  assert.notEqual((await request('releases', bad, owner.access_token)).status, 200)
  assert.equal((await fetch(publishedURL)).status, 200, 'failed update preserves release')
  const two = await request('releases', { ...input, requestKey: randomUUID(), artifact: artifact('Version two') }, owner.access_token); assert.equal(two.status, 200); releaseIds.push(two.data.id)
  assert.equal((await request('promote', { gameId, releaseId: two.data.id, generation: 1 }, owner.access_token)).status, 200)
  assert.equal((await fetch(publishedURL)).status, 404, 'old direct URLs cannot bypass current release')
  assert.equal((await request('promote', { gameId, releaseId: uploaded.data.id, generation: 2 }, owner.access_token)).status, 200, 'rollback')
  assert.equal((await fetch(publishedURL)).status, 200)
  assert.equal((await request('promote', { gameId, releaseId: null, generation: 3 }, owner.access_token)).status, 200, 'unpublish')
  assert.equal((await fetch(publishedURL)).status, 404)
  assert(!(await request('games')).data.some((g: any) => g.id === gameId))
  const secret = randomBytes(32).toString('hex'), challenge = createHash('sha256').update(secret).digest('hex')
  const device = await request('device/start', { challenge }); assert.equal(device.status, 200)
  assert((await request('device/poll', { code: device.data.code, secret })).data.pending)
  assert.equal((await request('device/approve', { code: device.data.code, refreshToken: owner.refresh_token }, owner.access_token)).status, 200)
  assert.notEqual((await request('device/poll', { code: device.data.code, secret: 'wrong' })).status, 200)
  const exchanged = (await request('device/poll', { code: device.data.code, secret })).data
  assert.equal((await db.publisher(exchanged.access_token)).id, users[0])
  assert.notEqual((await request('device/poll', { code: device.data.code, secret })).status, 200, 'device exchange is one-time')
  const direct = await fetch(`${config.url}/rest/v1/games`, { headers: { apikey: config.anon, Authorization: `Bearer ${owner.access_token}` } })
  assert.notEqual(direct.status, 200, 'browser cannot bypass publishing operations via PostgREST')
  const signup = await fetch(`${config.url}/auth/v1/signup`, { method: 'POST', headers: { apikey: config.anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `closed-${randomUUID()}@local.test`, password: randomBytes(24).toString('hex') }) })
  assert.notEqual(signup.status, 200, 'public signup is closed')
  console.log('PASS: real local Supabase auth, ownership, private previews, artifact checks, retry/restart recovery, update, stale promotion, rollback, unpublish, device sign-in, closed signup, and direct database denial.')
} finally {
  await db.table('games', `?id=eq.${gameId}`, { method: 'PATCH', body: JSON.stringify({ current_release_id: null }) })
  await db.table('publication_events', `?game_id=eq.${gameId}`, { method: 'DELETE' })
  await db.table('releases', `?game_id=eq.${gameId}`, { method: 'DELETE' })
  await db.table('games', `?id=eq.${gameId}`, { method: 'DELETE' })
  if (releaseIds.length) await db.request('/storage/v1/object/game-artifacts', { method: 'DELETE', body: JSON.stringify({ prefixes: releaseIds.map(id => `${id}.json`) }) })
  for (const id of users) {
    await db.table('publishers', `?id=eq.${id}`, { method: 'DELETE' })
    await db.request(`/auth/v1/admin/users/${id}`, { method: 'DELETE' })
  }
}
