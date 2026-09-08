import assert from 'node:assert/strict'
import test from 'node:test'
import { deployCatalog } from './catalog-deploy.mjs'

const sha = 'a'.repeat(40)
const credentials = { sha, token: 'test-token' }
const ready = {
  id: 'dpl_test', projectId: 'prj_9s1HO1s9K3qWbr1YMMHnasM5Ma0H',
  readyState: 'READY', aliasAssigned: true, target: 'production',
  alias: ['gauntletgamesmith.com'], gitSource: { sha },
}
function fixture(states) {
  const calls = [], logs = [], sleeps = []
  return {
    calls, logs, sleeps,
    dependencies: {
      request: async (url, options) => {
        calls.push({ url, ...options })
        return Response.json(options.method === 'POST' ? { id: ready.id } : states.shift())
      },
      sleep: async ms => { sleeps.push(ms) },
      log: line => logs.push(line),
    },
  }
}

test('deploys the tested SHA to the catalog and waits for the production alias', async () => {
  const f = fixture([
    { readyState: 'BUILDING' }, { ...ready, aliasAssigned: false }, ready,
  ])
  assert.deepEqual(await deployCatalog(credentials, f.dependencies), {
    id: ready.id, sha, url: 'https://gauntletgamesmith.com',
  })
  const creation = f.calls[0]
  assert.equal(creation.url.origin, 'https://api.vercel.com')
  assert.equal(creation.url.searchParams.get('teamId'), 'team_Xdj5d9SOU4rIrCYN4lxD4hGe')
  assert.equal(creation.headers.Authorization, 'Bearer test-token')
  assert.equal(creation.redirect, 'error')
  assert.deepEqual(JSON.parse(creation.body), {
    name: 'glassbox-arcade', project: ready.projectId, target: 'production',
    gitSource: { type: 'github', org: 'GlassBox-AI-Labs', repo: 'gauntlet-gamesmith', ref: 'main', sha },
  })
  assert(f.calls.slice(1).every(call => call.url.searchParams.get('withGitRepoInfo') === 'true'))
  assert.equal(f.sleeps.length, 2)
  assert(!f.logs.join('\n').includes(credentials.token))
})

test('missing token and malformed SHA make no API requests', async () => {
  const f = fixture([])
  await assert.rejects(deployCatalog({ sha, token: '' }, f.dependencies), /VERCEL_TOKEN/)
  await assert.rejects(deployCatalog({ ...credentials, sha: 'main' }, f.dependencies), /commit SHA/)
  assert.equal(f.calls.length, 0)
})

test('build failures, cancellations, and alias errors fail the job', async () => {
  for (const state of [{ readyState: 'ERROR' }, { readyState: 'CANCELED' }, { ...ready, aliasError: { message: 'private details' } }]) {
    const f = fixture([state])
    await assert.rejects(deployCatalog(credentials, f.dependencies), /Deployment dpl_test/)
    assert.equal(f.sleeps.length, 0)
    assert(!f.logs.join('\n').includes('private details'))
  }
})

test('a ready deployment must match the commit, project, and production domain', async () => {
  for (const mismatch of [
    { gitSource: { sha: 'b'.repeat(40) } }, { projectId: 'another-project' },
    { target: 'preview' }, { alias: ['other.example.com'] },
  ]) {
    await assert.rejects(deployCatalog(credentials, fixture([{ ...ready, ...mismatch }]).dependencies))
  }
})

test('HTTP errors do not expose response bodies or retry deployment creation', async () => {
  let calls = 0
  await assert.rejects(deployCatalog(credentials, {
    request: async () => { calls++; return new Response('private environment data', { status: 403 }) },
  }), error => error.message.includes('HTTP 403') && !error.message.includes('private environment'))
  assert.equal(calls, 1)
})

test('polling is bounded when Vercel remains queued', async () => {
  const f = fixture(Array.from({ length: 90 }, () => ({ readyState: 'QUEUED' })))
  await assert.rejects(deployCatalog(credentials, f.dependencies), /Timed out.*may still be running/)
  assert.equal(f.calls.length, 91)
  assert(f.sleeps.every(ms => ms === 10000))
})
