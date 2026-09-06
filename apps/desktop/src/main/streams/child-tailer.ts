import fs from 'node:fs'
import path from 'node:path'
import { readExactFileDescriptor } from '../bounded-fd'
import {
  MAX_CHILD_DIRECTORY_ENTRIES,
  MAX_CHILD_PROJECTION_READ_BYTES,
  MAX_CHILD_STREAMS,
  parseChildStreamName,
} from '../child-stream-name'
import { parseChildProcessExit } from '../child-process-exit'
import { translateClaudeLine, type StreamEvent } from './claude-stream'
import { translateCodexLine } from './codex-stream'

/**
 * Follows every delegated child stream in the attempt's `agents/` folder and turns
 * new lines into schema events attributed to the child's slug. Children can
 * appear mid-attempt, so each poll rescans the directory. This adds visibility
 * only — token and cost accounting stays in child-agents.ts, so no usage is
 * emitted or counted here.
 */
export interface ChildLogEvent extends StreamEvent {
  agentId: string
}

const MAX_LIFETIME_CHILD_STREAMS = 512

export class ChildStreamTailer {
  private offsets: Map<string, number>
  private identities = new Map<string, { dev: number; ino: number }>()
  private admitted = new Set<string>()
  private partials = new Map<string, Buffer>()
  private announced = new Set<string>()
  private briefsLogged = new Set<string>()
  private reportedErrors = new Set<string>()
  private lifetimeLimitReported = false

  constructor(
    private readonly dir: string,
    /** Streams untouched since the attempt began are a previous attempt's leftovers. */
    private readonly startedAtMs: number,
    initialOffsets?: Record<string, number>,
    initialIdentities: Record<string, { dev: number; ino: number }> = {},
  ) {
    const initial = Object.entries(initialOffsets ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    this.offsets = new Map(initial.slice(0, MAX_LIFETIME_CHILD_STREAMS))
    this.lifetimeLimitReported = initial.length > MAX_LIFETIME_CHILD_STREAMS
    for (const file of this.offsets.keys()) {
      const identity = initialIdentities[file]
      if (identity && Number.isSafeInteger(identity.dev) && identity.dev > 0 && Number.isSafeInteger(identity.ino) && identity.ino > 0) {
        this.identities.set(file, identity)
      } else if ((this.offsets.get(file) ?? 0) > 0) {
        throw new Error(`Delegated stream ${file} has a restored nonzero offset without its original file identity.`)
      }
      this.admitted.add(file)
      this.announced.add(file)
      this.briefsLogged.add(file)
    }
  }

  /**
   * Persist only bytes through the last complete newline. A restart can then
   * reread a bounded partial record and join it with bytes appended later.
   */
  snapshot(): Record<string, number> {
    return Object.fromEntries(
      [...this.offsets].map(([file, offset]) => [file, Math.max(0, offset - (this.partials.get(file)?.length ?? 0))]),
    )
  }

  identitySnapshot(): Record<string, { dev: number; ino: number }> {
    return Object.fromEntries(
      [...this.identities]
        .filter(([file]) => this.offsets.has(file))
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    )
  }

  poll(): ChildLogEvent[] {
    const out: ChildLogEvent[] = []
    if (this.lifetimeLimitReported) this.reportLifetimeLimit(out)
    const files: string[] = []
    let directory: fs.Dir | null = null
    try {
      directory = fs.opendirSync(this.dir)
      let exhausted = false
      for (let seen = 0; seen < MAX_CHILD_DIRECTORY_ENTRIES; seen += 1) {
        const entry = directory.readSync()
        if (!entry) {
          exhausted = true
          break
        }
        // Keep grammar-valid names even when their file type is unsafe so the
        // inspection below emits a visible rejection instead of hiding it.
        if (parseChildStreamName(entry.name)) files.push(entry.name)
        if (files.length >= MAX_CHILD_STREAMS) break
      }
      if (!exhausted) {
        out.push({
          agentId: 'child-tailer',
          channel: 'error',
          kind: 'error',
          text: `delegated stream inventory reached its ${MAX_CHILD_STREAMS}-stream/${MAX_CHILD_DIRECTORY_ENTRIES}-entry safety limit`,
        })
      }
      this.reportedErrors.delete('directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || this.reportedErrors.has('directory')) return []
      this.reportedErrors.add('directory')
      return [{
        agentId: 'child-tailer',
        channel: 'error',
        kind: 'error',
        text: `could not scan delegated agent streams: ${error instanceof Error ? error.message : String(error)}`,
      }]
    } finally {
      directory?.closeSync()
    }
    for (const file of files.sort()) {
      const named = parseChildStreamName(file)
      if (!named) continue
      if (!this.admitted.has(file)) {
        if (this.admitted.size >= MAX_LIFETIME_CHILD_STREAMS) {
          this.reportLifetimeLimit(out)
          continue
        }
        this.admitted.add(file)
      }
      const filePath = path.join(this.dir, file)
      let stat: fs.Stats
      try {
        const entry = fs.lstatSync(filePath)
        if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('stream is not a singly linked regular file')
        stat = entry
        this.reportedErrors.delete(`stat:${file}`)
      } catch (error) {
        if (!this.reportedErrors.has(`stat:${file}`)) {
          this.reportedErrors.add(`stat:${file}`)
          out.push({
            agentId: named.slug,
            channel: 'error',
            kind: 'error',
            text: `could not inspect delegated ${named.harness} stream: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
        continue
      }
      const priorIdentity = this.identities.get(file)
      if (priorIdentity && (priorIdentity.dev !== stat.dev || priorIdentity.ino !== stat.ino)) {
        throw new Error(`Delegated ${named.harness} stream ${file} changed identity after it was admitted; refusing replacement evidence.`)
      }
      if (!priorIdentity) this.identities.set(file, { dev: stat.dev, ino: stat.ino })
      let offset = this.offsets.get(file)
      if (offset === undefined) {
        const fresh = stat.mtimeMs >= this.startedAtMs
        offset = fresh ? 0 : stat.size
        this.offsets.set(file, offset)
        if (fresh) this.announce(file, named.slug, named.harness, out)
      }
      if (stat.size < offset) {
        throw new Error(`Delegated ${named.harness} stream ${file} shrank after ${offset} bytes were observed; refusing incomplete or replacement evidence.`)
      }
      if (stat.size <= offset) continue
      let buf: Buffer
      try {
        const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        try {
          const opened = fs.fstatSync(fd)
          if (
            !opened.isFile()
            || opened.nlink !== 1
            || opened.dev !== stat.dev
            || opened.ino !== stat.ino
            || opened.size < stat.size
          ) throw new Error('stream changed identity or shrank while it was being inspected')
          buf = Buffer.allocUnsafe(Math.min(MAX_CHILD_PROJECTION_READ_BYTES, stat.size - offset))
          const read = fs.readSync(fd, buf, 0, buf.length, offset)
          buf = buf.subarray(0, read)
        } finally {
          fs.closeSync(fd)
        }
        this.reportedErrors.delete(`read:${file}`)
      } catch (error) {
        if (error instanceof Error && /changed identity|shrank/.test(error.message)) {
          throw new Error(`Delegated ${named.harness} stream ${file} failed its immutable evidence boundary: ${error.message}`)
        }
        if (!this.reportedErrors.has(`read:${file}`)) {
          this.reportedErrors.add(`read:${file}`)
          out.push({
            agentId: named.slug,
            channel: 'error',
            kind: 'error',
            text: `could not read delegated ${named.harness} stream: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
        continue
      }
      this.offsets.set(file, offset + buf.length)
      // Split on the byte, not the string: a read can land mid-character.
      const combined = Buffer.concat([this.partials.get(file) ?? Buffer.alloc(0), buf])
      const lastNewline = combined.lastIndexOf(0x0a)
      if (lastNewline < 0) {
        if (combined.length > MAX_CHILD_PROJECTION_READ_BYTES) {
          this.partials.set(file, combined.subarray(-MAX_CHILD_PROJECTION_READ_BYTES))
          const key = `line:${file}`
          if (!this.reportedErrors.has(key)) {
            this.reportedErrors.add(key)
            out.push({
              agentId: named.slug,
              channel: 'error',
              kind: 'error',
              text: `delegated ${named.harness} stream line exceeded the 1 MiB projection limit; raw evidence remains on disk`,
            })
          }
        } else {
          this.partials.set(file, combined)
        }
        continue
      }
      this.partials.set(file, combined.subarray(lastNewline + 1))
      for (const line of combined.subarray(0, lastNewline).toString('utf8').split('\n')) {
        if (Buffer.byteLength(line, 'utf8') > MAX_CHILD_PROJECTION_READ_BYTES) {
          out.push({
            agentId: named.slug,
            channel: 'error',
            kind: 'error',
            text: `delegated ${named.harness} stream event exceeded the 1 MiB projection limit; raw evidence remains on disk`,
          })
          continue
        }
        try {
          const processExit = parseChildProcessExit(line)
          if (processExit) {
            out.push({
              agentId: named.slug,
              channel: processExit.exitCode === 0 ? 'system' : 'error',
              kind: processExit.exitCode === 0 ? 'done' : 'error',
              text: processExit.exitCode === 0
                ? `delegated ${named.harness} process exited`
                : `delegated ${named.harness} process exited with status ${processExit.exitCode}`,
            })
            continue
          }
          if (named.harness === 'claude') {
            const translated = translateClaudeLine(line)
            for (const event of translated?.events ?? []) out.push({ ...event, agentId: named.slug })
            if (translated?.init) {
              out.push({
                agentId: named.slug,
                channel: 'system',
                kind: 'system',
                text: `delegated claude session ${translated.init.sessionId?.slice(0, 8) ?? '?'} · model ${translated.init.model ?? '?'}`,
              })
            }
            if (translated?.result && !translated.result.isError) {
              out.push({
                agentId: named.slug,
                channel: 'system',
                kind: 'done',
                text: `delegated claude result ${translated.result.subtype ?? 'completed'}`,
              })
            }
          } else {
            const translated = translateCodexLine(line)
            for (const event of translated?.events ?? []) out.push({ ...event, agentId: named.slug })
            if (translated?.threadStarted !== undefined) {
              out.push({
                agentId: named.slug,
                channel: 'system',
                kind: 'system',
                text: `delegated codex thread ${translated.threadStarted?.slice(0, 8) ?? '?'}`,
              })
            }
            if (translated?.turn) {
              out.push({ agentId: named.slug, channel: 'system', kind: 'done', text: 'delegated codex turn completed' })
            }
          }
        } catch (error) {
          out.push({
            agentId: named.slug,
            channel: 'error',
            kind: 'error',
            text: `could not translate delegated ${named.harness} stream event: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      }
    }
    return out
  }

  private announce(file: string, slug: string, harness: string, out: ChildLogEvent[]): void {
    if (!this.briefsLogged.has(file)) {
      this.briefsLogged.add(file)
      const briefPath = path.join(path.dirname(this.dir), `${harness}-${slug}.md`)
      try {
        const expected = fs.lstatSync(briefPath)
        if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1) {
          throw new Error('brief is not a singly linked regular file')
        }
        const descriptor = fs.openSync(briefPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        let brief: string
        try {
          const stat = fs.fstatSync(descriptor)
          if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== expected.dev || stat.ino !== expected.ino) {
            throw new Error('brief is not a singly linked regular file')
          }
          if (stat.size > 256 * 1024) throw new Error('brief exceeds the 256 KiB visibility limit')
          brief = readExactFileDescriptor(descriptor, stat.size, 256 * 1024, 'Delegated brief').toString('utf8')
          const after = fs.fstatSync(descriptor)
          const linkedAfter = fs.lstatSync(briefPath)
          if (
            after.dev !== stat.dev || after.ino !== stat.ino || after.nlink !== 1 || after.size !== stat.size
            || linkedAfter.dev !== stat.dev || linkedAfter.ino !== stat.ino || linkedAfter.nlink !== 1
          ) throw new Error('brief changed identity or size while it was read')
        } finally {
          fs.closeSync(descriptor)
        }
        const chunks = Array.from({ length: Math.max(1, Math.ceil(brief.length / 3_600)) }, (_, index) =>
          brief.slice(index * 3_600, (index + 1) * 3_600),
        )
        for (const [index, chunk] of chunks.entries()) {
          out.push({
            agentId: slug,
            channel: 'prompt',
            kind: 'prompt',
            text: `Delegated ${harness} brief${chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ''}:\n${chunk}`,
          })
        }
      } catch (error) {
        out.push({
          agentId: slug,
          channel: 'error',
          kind: 'error',
          text: `could not expose delegated ${harness} brief: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    if (!this.announced.has(file)) {
      this.announced.add(file)
      out.push({
        agentId: slug,
        channel: 'tool',
        kind: 'spawn',
        text: `⇉ delegated ${harness} worker "${slug}" stream appeared`,
      })
    }
  }

  private reportLifetimeLimit(out: ChildLogEvent[]): void {
    if (this.reportedErrors.has('lifetime-stream-limit')) return
    this.reportedErrors.add('lifetime-stream-limit')
    out.push({
      agentId: 'child-tailer',
      channel: 'error',
      kind: 'error',
      text: `delegated stream projection reached its ${MAX_LIFETIME_CHILD_STREAMS}-stream lifetime limit; additional raw evidence remains on disk`,
    })
  }
}
