import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const project = 'prj_9s1HO1s9K3qWbr1YMMHnasM5Ma0H'
const team = 'team_Xdj5d9SOU4rIrCYN4lxD4hGe'
const domain = 'gauntletgamesmith.com'

export async function deployCatalog(
  { sha, token },
  { request = fetch, sleep = setTimeout, log = console.log } = {},
) {
  assert(typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha), 'A full tested commit SHA is required')
  assert(typeof token === 'string' && token.trim(), 'Add the VERCEL_TOKEN GitHub Actions secret for the GlassBox Vercel account')

  async function api(path, body) {
    const url = new URL(`https://api.vercel.com${path}`)
    url.searchParams.set('teamId', team)
    if (!body) url.searchParams.set('withGitRepoInfo', 'true')
    const response = await request(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    })
    // API bodies can include server environments. Never print them, even on failure.
    assert(response.ok, `Vercel API returned HTTP ${response.status}; inspect the deployment in the GlassBox dashboard`)
    return response.json()
  }

  const created = await api('/v13/deployments', {
    name: 'glassbox-arcade',
    project,
    target: 'production',
    gitSource: {
      type: 'github', org: 'GlassBox-AI-Labs', repo: 'gauntlet-gamesmith', ref: 'main', sha,
    },
  })
  assert(typeof created.id === 'string' && /^dpl_[a-zA-Z0-9]+$/.test(created.id), 'Vercel did not return a deployment ID')
  const id = created.id
  log(`Created ${id} for ${sha}`)
  let previousState
  for (let attempt = 0; attempt < 90; attempt++) {
    const deployment = await api(`/v13/deployments/${id}`)
    const state = deployment.readyState
    assert(['QUEUED', 'INITIALIZING', 'BUILDING', 'READY', 'ERROR', 'CANCELED'].includes(state), 'Vercel returned an unsupported deployment state')
    if (state !== previousState) {
      log(`${id}: ${state}`)
      previousState = state
    }
    assert(!['ERROR', 'CANCELED'].includes(state), `Deployment ${id} ${state}; inspect Vercel build logs`)
    assert(!deployment.aliasError, `Deployment ${id} failed to assign its production alias`)
    if (state === 'READY' && deployment.aliasAssigned === true) {
      assert(deployment.id === id && deployment.projectId === project, 'Deployment project or ID does not match')
      assert(deployment.gitSource?.sha === sha, 'Deployment source does not match the tested commit')
      assert(deployment.target === 'production' && deployment.alias?.includes(domain), 'Deployment does not serve the production catalog domain')
      log(`Production ready: https://${domain} (${id}, ${sha})`)
      return { id, sha, url: `https://${domain}` }
    }
    await sleep(10000)
  }
  throw new Error(`Timed out waiting for ${id}; inspect Vercel before retrying because its build may still be running`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_REF === 'refs/heads/main', 'Production deployment requires a manual workflow on main')
    assert(process.env.GITHUB_REPOSITORY === 'GlassBox-AI-Labs/gauntlet-gamesmith', 'Unexpected deployment repository')
    const result = await deployCatalog({ sha: process.env.GITHUB_SHA, token: process.env.VERCEL_TOKEN })
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `Deployed ${result.sha} as ${result.id}: ${result.url}\n`)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
