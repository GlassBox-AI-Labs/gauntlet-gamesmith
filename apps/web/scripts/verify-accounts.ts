import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { localEnvironment } from './environment.mjs'
import { localClient } from '../server/supabase'

const env = localEnvironment()
const base = process.env.CATALOG_TEST_URL ?? 'http://127.0.0.1:4310'
for (const target of [env.SUPABASE_URL!, base]) {
  const url = new URL(target)
  assert(
    url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(url.hostname),
    'Account verification only runs against local services',
  )
}
const db = localClient()
const email = `verify-${randomUUID()}@challenger.gauntletai.com`
const password = randomBytes(24).toString('hex')
let userId: string | undefined
async function request(route: string, input?: unknown, token?: string) {
  const response = await fetch(`${base}/api/${route}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  })
  assert.equal(response.headers.get('set-cookie'), null)
  return { status: response.status, data: await response.json() }
}
try {
  for (const denied of [
    'person@gauntletai.com',
    'person@sub.challenger.gauntletai.com',
    'person@challenger.gauntletai.com.evil.test',
  ])
    assert.equal(
      (
        await request('signup', {
          email: denied,
          password,
          displayName: 'Denied',
        })
      ).status,
      400,
    )
  const signup = await request('signup', {
    email,
    password,
    displayName: 'Challenger verification',
  })
  assert.equal(signup.status, 200)
  assert.deepEqual(signup.data, { verificationRequired: true })
  const users = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  assert.ifError(users.error)
  userId = users.data.users.find((user) => user.email === email)?.id
  assert.ok(userId)
  assert.equal((await request('login', { email, password })).status, 401)
  const before = await db.rpc('publisher_for_user', { actor: userId })
  assert.ifError(before.error)
  assert.equal(before.data, null)
  let messageId: string | undefined
  for (let attempt = 0; attempt < 30 && !messageId; attempt++) {
    const inbox = await (
      await fetch('http://127.0.0.1:56324/api/v1/messages')
    ).json()
    messageId = inbox.messages.find(
      (message: { ID: string; To: { Address: string }[] }) =>
        message.To.some((to) => to.Address === email),
    )?.ID
    if (!messageId) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.ok(messageId, 'Local confirmation email was not delivered')
  const message = await (
    await fetch(`http://127.0.0.1:56324/api/v1/message/${messageId}`)
  ).json()
  const code = String(message.HTML).match(/\b\d{6,10}\b/)?.[0]
  assert.ok(code, 'Confirmation template must show the email code')
  assert.equal(
    (
      await request('verify-email', {
        email,
        code: code === '000000' ? '111111' : '000000',
      })
    ).status,
    401,
  )
  const verified = await request('verify-email', { email, code })
  assert.equal(verified.status, 200)
  assert.equal(verified.data.publisher.id, userId)
  assert.equal(verified.data.publisher.display_name, 'Challenger verification')
  assert.equal((await request('verify-email', { email, code })).status, 401)
  const login = await request('login', { email, password })
  assert.equal(login.status, 200)
  const token = login.data.access_token
  assert.equal((await request('me', undefined, token)).status, 200)
  assert.ifError(
    (await db.from('publishers').update({ enabled: false }).eq('id', userId))
      .error,
  )
  assert.equal((await request('me', undefined, token)).status, 401)
  assert.equal(
    (await db.from('publishers').select('enabled').eq('id', userId).single())
      .data?.enabled,
    false,
  )
  assert.ifError(
    (await db.from('publishers').update({ enabled: true }).eq('id', userId))
      .error,
  )
  assert.ifError(
    (
      await db.auth.admin.updateUserById(userId, {
        email: `changed-${randomUUID()}@example.com`,
        email_confirm: true,
      })
    ).error,
  )
  assert.equal((await request('me', undefined, token)).status, 401)
  console.log(
    'PASS exact domain, confirmation email, denied unverified/wrong/replayed code, automatic enrollment, password login, disabled account, changed email, and no auth cookies',
  )
} finally {
  if (userId) {
    assert.ifError(
      (await db.from('publishers').delete().eq('id', userId)).error,
    )
    assert.ifError((await db.auth.admin.deleteUser(userId)).error)
  }
}
