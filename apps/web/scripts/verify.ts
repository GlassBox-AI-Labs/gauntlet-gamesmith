import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { Catalog } from '@gauntlet/data/api/catalog'
import { digest, validateArtifact } from '@gauntlet/publishing/node'
import { localEnvironment } from './environment.mjs'
import { localClient } from '../server/supabase'
const env = localEnvironment(),
  db = localClient(),
  base = process.env.CATALOG_TEST_URL ?? 'http://127.0.0.1:4310',
  gameId = randomUUID(),
  users: string[] = [],
  ids: string[] = []
assert.match(env.SUPABASE_URL!, /^http:\/\/(127\.0\.0\.1|localhost):/)
const capture = (error: unknown, context: string) => {
    console.error(context)
  },
  catalog = new Catalog(db, env.CATALOG_SECRET!, capture)
async function request(route: string, input?: unknown, token?: string) {
  const response = await fetch(`${base}/api/${route}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  })
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie'),
  }
}
async function account() {
  const email = `verify-${randomUUID()}@local.test`,
    password = randomBytes(24).toString('hex')
  const created = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  assert.ifError(created.error)
  const id = created.data.user!.id
  users.push(id)
  assert.ifError(
    (
      await db.from('publishers').insert({
        id,
        handle: `verify-${id}`,
        display_name: 'Verification publisher',
      })
    ).error,
  )
  assert.equal(
    (await request('login', { email, password: 'incorrect-password' })).status,
    401,
  )
  const login = await request('login', { email, password })
  assert.equal(login.status, 200)
  assert.equal(login.data.publisher.id, id)
  assert.equal(login.cookie, null)
  return { ...login.data, email, password }
}
const source = {
    loopId: randomUUID(),
    runId: randomUUID(),
    round: 1,
    revision: 'a'.repeat(40),
  },
  listing = {
    title: 'Integration maze',
    slug: `verify-${gameId}`,
    description: 'Verification',
    controls: 'Arrows',
    coverPath: null,
  }
const artifact = (html: string) => ({
  version: 1 as const,
  sourceRevision: source.revision,
  files: [
    {
      path: 'index.html',
      data: Buffer.from(html).toString('base64'),
      sha256: digest(html),
    },
  ],
})
try {
  const owner = await account(),
    other = await account(),
    build = artifact('<h1>First saved round</h1>'),
    input = {
      gameId,
      requestKey: randomUUID(),
      listing,
      source,
      digest: validateArtifact(build).digest,
    }
  assert.equal((await request('releases', input)).status, 401)
  assert.equal(
    (
      await request(
        'releases',
        { ...input, source: undefined },
        owner.access_token,
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await request(
        'releases',
        { ...input, artifact: build },
        owner.access_token,
      )
    ).status,
    400,
  )
  const begin = await request('releases', input, owner.access_token)
  assert.equal(begin.status, 200, JSON.stringify(begin.data))
  ids.push(begin.data.releaseId)
  assert.equal(
    (await request('releases', input, owner.access_token)).data.releaseId,
    begin.data.releaseId,
  )
  assert.notEqual(
    (await request('releases', input, other.access_token)).status,
    200,
  )
  const uploaded = await fetch(begin.data.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(build),
  })
  assert(uploaded.ok, await uploaded.text())
  const complete = await request(
    'releases/complete',
    { releaseId: ids[0] },
    owner.access_token,
  )
  assert.equal(complete.status, 200, JSON.stringify(complete.data))
  assert.equal(complete.data.status, 'ready')
  assert.equal(
    (
      await request(
        'releases/complete',
        { releaseId: ids[0] },
        owner.access_token,
      )
    ).status,
    200,
  )
  assert.notEqual(
    (await request('preview', { releaseId: ids[0] }, other.access_token))
      .status,
    200,
  )
  const preview = await request(
    'preview',
    { releaseId: ids[0] },
    owner.access_token,
  )
  assert.equal(preview.status, 200)
  assert.equal((await fetch(preview.data.url)).status, 200)
  const promote = { gameId, releaseId: ids[0], generation: 0 }
  assert.notEqual(
    (await request('promote', promote, other.access_token)).status,
    200,
  )
  assert.equal(
    (await request('promote', promote, owner.access_token)).status,
    200,
  )
  assert.notEqual(
    (await request('promote', promote, owner.access_token)).status,
    200,
  )
  const second = artifact('<h1>Second saved round</h1>'),
    next = await request(
      'releases',
      {
        ...input,
        requestKey: randomUUID(),
        digest: validateArtifact(second).digest,
      },
      owner.access_token,
    )
  assert.equal(next.status, 200)
  ids.push(next.data.releaseId)
  assert(
    (
      await fetch(next.data.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(second),
      })
    ).ok,
  )
  // A fresh domain instance can resume completion; no in-memory server state is required.
  assert.equal(
    (
      await new Catalog(db, env.CATALOG_SECRET!, capture).complete(
        users[0],
        ids[1],
      )
    ).status,
    'ready',
  )
  assert.equal(
    (
      await request(
        'promote',
        { gameId, releaseId: ids[1], generation: 1 },
        owner.access_token,
      )
    ).status,
    200,
  )
  assert.equal(
    (
      await request(
        'promote',
        { gameId, releaseId: ids[0], generation: 2 },
        owner.access_token,
      )
    ).status,
    200,
  )
  assert.equal(
    (
      await request(
        'promote',
        { gameId, releaseId: null, generation: 3 },
        owner.access_token,
      )
    ).status,
    200,
  )
  assert(
    !(await request('games')).data.some((g: { id: string }) => g.id === gameId),
  )
  // Invalid bytes and forged source metadata never become ready releases.
  for (const invalid of [
    {
      ...build,
      files: [
        { ...build.files[0], data: Buffer.from('tampered').toString('base64') },
      ],
    },
    { ...build, sourceRevision: 'b'.repeat(40) },
  ]) {
    const candidate = await request(
      'releases',
      { ...input, requestKey: randomUUID() },
      owner.access_token,
    )
    assert.equal(candidate.status, 200)
    ids.push(candidate.data.releaseId)
    assert(
      (
        await fetch(candidate.data.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(invalid),
        })
      ).ok,
    )
    assert.notEqual(
      (
        await request(
          'releases/complete',
          { releaseId: candidate.data.releaseId },
          owner.access_token,
        )
      ).status,
      200,
    )
    assert.equal(
      (await catalog.release(candidate.data.releaseId)).status,
      'failed',
    )
  }
  const cookieAttempt = await fetch(`${base}/api/promote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'sb-auth-token=browser-session',
    },
    body: JSON.stringify(promote),
  })
  assert.equal(cookieAttempt.status, 401)
  assert.ifError(
    (await db.from('publishers').update({ enabled: false }).eq('id', users[0]))
      .error,
  )
  assert.equal((await request('me', undefined, owner.access_token)).status, 401)
  assert.equal(
    (await request('login', { email: owner.email, password: owner.password }))
      .status,
    401,
  )
  assert.ifError(
    (await db.from('publishers').update({ enabled: true }).eq('id', users[0]))
      .error,
  )
  const direct = await fetch(`${env.SUPABASE_URL}/rest/v1/games`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${owner.access_token}`,
    },
  })
  assert.notEqual(direct.status, 200)
  for (const route of [
    '/dashboard',
    '/login',
    '/connect',
    '/connect/complete',
    '/api/device/start',
  ])
    assert.equal((await fetch(`${base}${route}`)).status, 404)
  console.log(
    'PASS: saved-round provenance, desktop-only endpoints, signed uploads, immutable validation, restart retry, owner checks, promotion, rollback, unpublish, native email/password sign-in with no browser cookies, and read-only website.',
  )
} finally {
  await db.from('games').update({ current_release_id: null }).eq('id', gameId)
  await db.from('publication_events').delete().eq('game_id', gameId)
  await db.from('releases').delete().eq('game_id', gameId)
  await db.from('games').delete().eq('id', gameId)
  await db.storage
    .from('game-artifacts')
    .remove(ids.flatMap((id) => [`${id}.json`, `pending/${id}.json`]))
  for (const id of users) {
    await db.from('publishers').delete().eq('id', id)
    await db.auth.admin.deleteUser(id)
  }
}
