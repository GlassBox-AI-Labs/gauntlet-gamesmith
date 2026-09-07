import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
import { buildPublication, recoverPublicationBuild, restorePublicationBuild, type BuildJob } from './publication-build'
const directories: string[] = []
function workspace(script: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-build-test-')); directories.push(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: script } }))
  return dir
}
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
describe('publication builds', () => {
  it('persists ownership before executing and records build output', async () => {
    const dir = workspace('node build.cjs'), records: BuildJob[] = [], logs: string[] = []
    fs.writeFileSync(path.join(dir, 'build.cjs'), "require('fs').mkdirSync('dist'); require('fs').writeFileSync('dist/index.html','game'); console.log('build complete')")
    await buildPublication(dir, job => { records.push(job); directories.push(job.gateDir) }, text => logs.push(text))
    expect(records.map(r => r.status)).toEqual(['starting', 'running', 'finished'])
    expect(fs.readFileSync(path.join(dir, 'dist/index.html'), 'utf8')).toBe('game')
    expect(logs.join('\n')).toContain('build complete')
    await expect(recoverPublicationBuild(records.at(-1)!, () => {})).resolves.toBeUndefined()
  }, 15000)
  it('reports nonzero builds and fails closed on incomplete launch recovery', async () => {
    const dir = workspace('node -e "process.exit(7)"')
    await expect(buildPublication(dir, job => directories.push(job.gateDir), () => {})).rejects.toThrow('exited 7')
    await expect(recoverPublicationBuild({ directory: dir, attemptId: '123e4567-e89b-42d3-a456-426614174000', status: 'starting', gateDir: '' }, () => {})).rejects.toThrow('incomplete process ownership')
  }, 15000)
})

describe('restoring a persisted publication build', () => {
  const record = (status: string) => ({
    directory: '/w/.gauntlet-gamesmith/play/round-1-abc123abc123-0e5147e9-8b2c-42f7-99c0-08dc44ebddbc',
    status,
    attemptId: 'caed5db9-7a77-4b24-803b-98be9be50824',
    gateDir: '/tmp/gauntlet-publish-gate-x',
  })

  it('keeps a record whose checkout is still on disk', () => {
    const restored = restorePublicationBuild(record('finished'), () => true, '/jobs/build.json')
    expect(restored).toEqual({ ...record('finished'), status: 'finished' })
  })

  it('spends a finished record whose checkout the operator removed', () => {
    // The saved-round storage limits tell the operator to remove retained
    // checkouts. Doing so used to throw ENOENT out of the job reader and left
    // publishing permanently unable to read its own record.
    expect(restorePublicationBuild(record('finished'), () => false, '/jobs/build.json')).toBeNull()
  })

  it.each(['starting', 'running'])('fails closed when a %s build lost the checkout holding its process metadata', (status) => {
    expect(() => restorePublicationBuild(record(status), () => false, '/jobs/build.json'))
      .toThrow(/cannot prove it stopped[\s\S]*\/jobs\/build\.json/)
  })

  it('lets the presence probe reject a path that does not resolve to itself', () => {
    expect(() => restorePublicationBuild(record('finished'), () => { throw new Error('Publishing build record is invalid.') }, '/jobs/build.json'))
      .toThrow('Publishing build record is invalid.')
  })
})
