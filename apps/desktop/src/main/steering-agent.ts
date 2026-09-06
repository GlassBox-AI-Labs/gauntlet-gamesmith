import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { consultPlan } from './harness-plans'
import { cliExecutable } from './cli-executable'
import { createCodexStream } from './streams/codex-stream'
import { prepareProcessMeta, completeProcessMeta, processGroupIdentity, processGroupStillOwned, interruptCapturedProcessGroup, readProcessIdentity, type RunProcessMeta } from './run-process'
import type { StreamEvent } from './streams/claude-stream'
import type { TokenTotals } from '../shared/loop'
import { STEERING_REPLY_SCHEMA } from '../shared/steering'

export interface ConsultInput {
  prompt: string; model: string; workspaceDir: string; attemptId: string; signal: AbortSignal
  imagePaths?: string[]
  onEvent?: (event: StreamEvent) => void
  onStarted?: (version: string) => void
}
export interface ConsultResult { text: string; tokens: TokenTotals | null; sessionId: string | null }
export type ConsultAgent = ((input: ConsultInput) => Promise<ConsultResult>) & { recover?: (attemptId: string) => Promise<boolean> }

export function consultArgs(input: ConsultInput, schemaPath: string): string[] { return consultPlan(input.model, schemaPath, input.imagePaths) }

/** A separate read-only process, with private ownership and normal portable raw streams. */
export function createConsultAgent(privateDir: string, environment: () => Record<string, string>): ConsultAgent {
  const ownershipPath = (id: string) => path.join(privateDir, `${id}.process.json`)
  const settle = (meta: Pick<RunProcessMeta, 'pid' | 'groupIdentities'>, report: (message: string) => void) => new Promise<boolean>(resolve => {
    interruptCapturedProcessGroup(meta.pid, meta.groupIdentities, report, outcome => resolve(outcome === 'gone'))
  })
  const agent: ConsultAgent = input => new Promise((resolve, reject) => {
    // Resolve all preflight dependencies before leaving a durable starting marker.
    const binary = cliExecutable('codex', [input.workspaceDir]), env = environment()
    const versionResult = spawnSync(binary, ['--version'], { cwd: input.workspaceDir, env, encoding: 'utf8', timeout: 8000, maxBuffer: 64000 })
    const version = versionResult.status === 0 ? versionResult.stdout.trim().slice(0, 200) : 'unavailable'
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 })
    const schemaPath = path.join(privateDir, `${input.attemptId}.schema.json`), privatePath = ownershipPath(input.attemptId)
    const save = (value: unknown) => {
      const temp = `${privatePath}.tmp`
      fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, privatePath)
    }
    fs.writeFileSync(schemaPath, JSON.stringify(STEERING_REPLY_SCHEMA), { mode: 0o600 })
    const workspace = fs.statSync(input.workspaceDir), started = Date.now()
    const marker = prepareProcessMeta(input.workspaceDir, input.attemptId, started, { dev: workspace.dev, ino: workspace.ino })
    let out: number | undefined, err: number | undefined
    try {
      out = fs.openSync(marker.outPath, 'wx', 0o600)
      err = fs.openSync(marker.errPath, 'wx', 0o600)
      save({ state: 'starting' })
    } catch (error) {
      if (out !== undefined) fs.closeSync(out)
      if (err !== undefined) fs.closeSync(err)
      fs.rmSync(schemaPath, { force: true })
      throw error
    }
    const outStat = fs.fstatSync(out), errStat = fs.fstatSync(err)
    let meta: RunProcessMeta | null = null, buffer = '', text = '', sessionId: string | null = null, tokens: TokenTotals | null = null, failure = '', size = 0
    let stopping: Promise<boolean> | null = null
    const decoder = new StringDecoder('utf8')
    const stream = createCodexStream()
    // Persistence failure is itself terminal. Do not recursively emit while stopping.
    const emit = (event: StreamEvent) => {
      try { input.onEvent?.(event) } catch (error) {
        failure = error instanceof Error ? error.message : 'Unable to persist chat output.'
        queueMicrotask(() => { void stop() })
      }
    }
    const report = (text: string) => emit({ kind: 'process-control', channel: 'system', text })
    const child = spawn(binary, consultArgs(input, schemaPath), { cwd: input.workspaceDir, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stop = (): Promise<boolean> => {
      if (stopping) return stopping
      if (meta) return stopping = settle(meta, report)
      if (child.pid && readProcessIdentity(child.pid)) {
        const identities = processGroupIdentity(child.pid)
        if (identities.length) return stopping = settle({ pid: child.pid, groupIdentities: identities }, report)
      }
      child.kill('SIGINT')
      return Promise.resolve(false)
    }
    const timeout = setTimeout(() => { failure = 'Chat timed out. Please try again.'; void stop() }, 180000)
    const abort = () => { failure = 'Response stopped.'; void stop() }
    input.signal.addEventListener('abort', abort, { once: true })
    const monitor = setInterval(() => {
      if (meta && processGroupStillOwned(meta.pid, meta.groupIdentities)) {
        meta.groupIdentities = [...new Set([...meta.groupIdentities, ...processGroupIdentity(meta.pid)])].slice(0, 256)
        try { save(meta) } catch { failure = 'Could not retain chat process identity.'; void stop() }
      }
    }, 1000)
    monitor.unref()
    const parseLine = (line: string) => {
      const parsed = stream.onLine(line)
      if (!parsed) return
      for (const event of parsed.events) emit(event)
      if (parsed.summary) text = parsed.summary
      if (parsed.threadStarted) sessionId = parsed.threadStarted
      if (parsed.turn?.usage) {
        // One exec has one turn; repeated cumulative completion reports replace totals.
        const usage = parsed.turn.usage, inputTokens = Number(usage.input_tokens) || 0, cached = Number(usage.cached_input_tokens) || 0
        tokens = { input: Math.max(0, inputTokens - cached), output: Number(usage.output_tokens) || 0, cacheRead: cached, cacheWrite: 0 }
      }
    }
    const recordChunk = (fd: number, chunk: Buffer): boolean => {
      try { fs.writeSync(fd, chunk) } catch { failure = 'Unable to preserve raw chat output.'; void stop(); return false }
      size += chunk.length
      if (size > 8_000_000) { failure = 'Chat output exceeded its limit.'; void stop(); return false }
      return true
    }
    child.on('spawn', () => {
      try {
        meta = completeProcessMeta(input.workspaceDir, input.attemptId, marker, child.pid!, undefined, { outDev: outStat.dev, outIno: outStat.ino, errDev: errStat.dev, errIno: errStat.ino })
        save(meta)
        input.onStarted?.(version)
        emit({ kind: 'raw-stream', channel: 'system', text: 'Steering raw output streams opened.' })
        if (input.signal.aborted) abort()
        else child.stdin.end(input.prompt)
      } catch (error) { failure = error instanceof Error ? error.message : 'Unable to record chat process ownership.'; void stop() }
    })
    child.on('error', error => { failure = `Could not start Codex: ${error.message}` })
    child.stdout.on('data', (chunk: Buffer) => {
      if (!recordChunk(out!, chunk)) return
      buffer += decoder.write(chunk)
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) { parseLine(buffer.slice(0, end)); buffer = buffer.slice(end + 1) }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (!recordChunk(err!, chunk)) return
      const content = chunk.toString()
      for (let index = 0; index < content.length; index += 4000) emit({ kind: 'stderr', channel: 'error', text: content.slice(index, index + 4000) })
    })
    child.on('close', code => {
      void (async () => {
        clearTimeout(timeout); clearInterval(monitor); input.signal.removeEventListener('abort', abort)
        buffer += decoder.end()
        if (buffer.trim()) parseLine(buffer)
        const gone = meta ? await (stopping ?? settle(meta, report)) : !child.pid
        fs.closeSync(out!); fs.closeSync(err!); fs.rmSync(schemaPath, { force: true })
        if (gone) fs.rmSync(privatePath, { force: true })
        if (!gone) failure = 'Chat process ownership could not be settled. Restart the app before continuing this conversation.'
        failure ||= stream.failure() ?? ''
        if (failure || code !== 0 || !text) throw Object.assign(new Error(failure || `Codex returned no response (exit ${code}). Check its connection on the Agents tab.`), { tokens, sessionId, unresolved: !gone })
        return { text, tokens, sessionId }
      })().then(resolve, reject)
    })
    child.stdin.on('error', () => {})
  })
  agent.recover = async id => {
    const file = ownershipPath(id)
    if (!fs.existsSync(file)) return true
    if (fs.statSync(file).size > 256000) return false
    const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as RunProcessMeta
    if (!Number.isSafeInteger(meta.pid) || meta.pid <= 1 || !Array.isArray(meta.groupIdentities) || meta.groupIdentities.length > 256 || !meta.groupIdentities.every(identity => typeof identity === 'string')) return false
    const gone = await settle(meta, () => {})
    if (gone) fs.rmSync(file, { force: true })
    return gone
  }
  return agent
}
