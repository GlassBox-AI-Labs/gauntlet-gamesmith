import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { playEnvironment } from './play'
import { readExactFileDescriptor } from './bounded-fd'
import { trackPublicationOutput } from './publication-output'
import { completeProcessMeta, interruptCapturedProcessGroup, prepareProcessMeta, processGroupIdentity, readProcessMeta, type AttemptProcessMeta } from './attempt-process'

export interface BuildJob { directory: string; attemptId: string; status: 'starting' | 'running' | 'finished'; gateDir: string }
/** A persisted, gated build; uses the existing exact-identity SIGINT supervisor. */
export async function buildPublication(directory: string, record: (job: BuildJob) => void, log: (text: string) => void): Promise<string> {
  const manifest = fs.openSync(path.join(directory, 'package.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let pkg
  try {
    const stat = fs.fstatSync(manifest)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Build manifest must be a bounded regular file.')
    pkg = JSON.parse(readExactFileDescriptor(manifest, stat.size, 1024 * 1024, 'build manifest').toString('utf8'))
  } finally { fs.closeSync(manifest) }
  if (typeof pkg.scripts?.build !== 'string') throw new Error('This saved round needs a package.json build script.')
  const output = await trackPublicationOutput(directory, log)
  const args = ['run', 'build', ...( /\bvite\s+build\b/.test(pkg.scripts.build) ? ['--', '--base=./'] : [])]
  const attemptId = randomUUID(), gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-publish-gate-'))
  const job: BuildJob = { directory, attemptId, gateDir, status: 'starting' }
  record(job)
  const stat = fs.statSync(directory), marker = prepareProcessMeta(directory, attemptId, Date.now(), { dev: stat.dev, ino: stat.ino })
  const out = fs.openSync(marker.outPath, 'wx+', 0o600)
  let err: number
  try { err = fs.openSync(marker.errPath, 'wx+', 0o600) } catch (error) { fs.closeSync(out); throw error }
  const child = spawn('/bin/sh', ['-c', 'while [ ! -f "$1" ]; do /bin/sleep 0.01; done; shift; exec "$@"', 'gauntlet-publish-build', path.join(gateDir, 'release'), 'npm', ...args], { cwd: directory, env: playEnvironment(directory), detached: true, stdio: ['ignore', out, err] })
  let meta: AttemptProcessMeta
  const completed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)) })
  // Attach rejection handling before identity inspection to avoid an unhandled spawn error.
  void completed.catch(() => {})
  try {
    if (!child.pid) throw new Error('Build did not return a process identity.')
    meta = completeProcessMeta(directory, attemptId, marker, child.pid)
  } catch (error) {
    child.kill('SIGINT') // direct, still-gated child handle; project code was never released
    await completed.catch(() => {})
    fs.closeSync(out); fs.closeSync(err)
    throw error
  }
  const offsets = new Map<number, number>()
  function scan(): void {
    for (const fd of [out, err]) {
      const start = offsets.get(fd) ?? 0, size = fs.fstatSync(fd).size
      if (size <= start) continue
      const length = Math.min(size - start, 64 * 1024), buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, start)
      offsets.set(fd, start + length)
      for (let i = 0; i < buffer.length; i += 4000) log(buffer.subarray(i, i + 4000).toString('utf8'))
    }
    try {
      const now = processGroupIdentity(meta.pid)
      if (now.some(member => meta.groupIdentities.includes(member))) meta.groupIdentities = [...new Set([...meta.groupIdentities, ...now])]
    } catch { /* Retain exact owned identities; interruption fails closed. */ }
  }
  let timedOut = false
  const interrupt = (): Promise<void> => new Promise((resolve, reject) => interruptCapturedProcessGroup(meta.pid, meta.groupIdentities, log, outcome => outcome === 'gone' ? resolve() : reject(new Error('Compilation process ownership is unresolved. Retry after it exits.'))))
  const timer = setTimeout(() => { timedOut = true; void interrupt().catch(e => log(e.message)) }, 120000)
  const watcher = setInterval(() => { try { scan() } catch (e) { log(`Compilation stream inspection failed: ${e instanceof Error ? e.message : 'unknown error'}`) } }, 250)
  timer.unref(); watcher.unref()
  try {
    record({ ...job, status: 'running' })
    log(`Publishing compilation: npm ${args.join(' ')}. Full build streams are retained in the saved-round checkout.`)
    fs.writeFileSync(path.join(gateDir, 'release'), '')
    const code = await completed
    await interrupt() // settle lingering descendants before packaging output
    while ([out, err].some(fd => (offsets.get(fd) ?? 0) < fs.fstatSync(fd).size)) scan()
    record({ ...job, status: 'finished' })
    if (timedOut || code !== 0) throw new Error(timedOut ? 'Publishing build timed out.' : `Publishing build exited ${code}. See the build log.`)
    return await output()
  } catch (error) {
    await interrupt()
    throw error
  } finally { clearTimeout(timer); clearInterval(watcher); fs.closeSync(out); fs.closeSync(err) }
}

export async function recoverPublicationBuild(job: BuildJob, log: (text: string) => void): Promise<void> {
  if (job.status === 'finished') return
  const result = readProcessMeta(job.directory, job.attemptId)
  if (!result.meta) throw new Error('A previous publishing build has incomplete process ownership. Inspect its retained checkout before clearing its local job record.')
  // An exited leader does not prove that descendants are gone. The supervisor
  // proves group absence or fails closed if only unverified descendants remain.
  await new Promise<void>((resolve, reject) => interruptCapturedProcessGroup(result.meta!.pid, result.meta!.groupIdentities, log, outcome => outcome === 'gone' ? resolve() : reject(new Error('Previous publishing build has not stopped.'))))
}
