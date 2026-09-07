import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
import { buildPublication, recoverPublicationBuild, type BuildJob } from './publication-build'
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
