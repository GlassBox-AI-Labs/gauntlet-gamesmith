import fs from 'node:fs'
import path from 'node:path'
import { translateClaudeLine, type StreamEvent } from './claude-stream'
import { translateCodexLine } from './codex-stream'

/**
 * Follows every delegated child stream in the run's `agents/` folder and turns
 * new lines into schema events attributed to the child's slug. Children can
 * appear mid-run, so each poll rescans the directory. This adds visibility
 * only — token and cost accounting stays in child-agents.ts, so no usage is
 * emitted or counted here.
 */
export interface ChildLogEvent extends StreamEvent {
  agentId: string
}

export class ChildStreamTailer {
  private offsets: Map<string, number>
  private partials = new Map<string, Buffer>()

  constructor(
    private readonly dir: string,
    /** Streams untouched since the run began are a previous run's leftovers. */
    private readonly startedAtMs: number,
    initialOffsets?: Record<string, number>,
  ) {
    this.offsets = new Map(Object.entries(initialOffsets ?? {}))
  }

  /** Byte offsets to persist so a re-attach does not replay child logs. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.offsets)
  }

  poll(): ChildLogEvent[] {
    let files: string[]
    try {
      files = fs.readdirSync(this.dir)
    } catch {
      return []
    }
    const out: ChildLogEvent[] = []
    for (const file of files.sort()) {
      const named = /^(.+)\.(claude|codex)\.jsonl$/.exec(file)
      if (!named) continue
      const filePath = path.join(this.dir, file)
      let stat: fs.Stats
      try {
        stat = fs.statSync(filePath)
      } catch {
        continue
      }
      let offset = this.offsets.get(file)
      if (offset === undefined) {
        offset = stat.mtimeMs < this.startedAtMs ? stat.size : 0
        this.offsets.set(file, offset)
      }
      if (stat.size <= offset) continue
      let buf: Buffer
      try {
        const fd = fs.openSync(filePath, 'r')
        try {
          buf = Buffer.allocUnsafe(stat.size - offset)
          const read = fs.readSync(fd, buf, 0, buf.length, offset)
          buf = buf.subarray(0, read)
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        continue
      }
      this.offsets.set(file, offset + buf.length)
      // Split on the byte, not the string: a read can land mid-character.
      const combined = Buffer.concat([this.partials.get(file) ?? Buffer.alloc(0), buf])
      const lastNewline = combined.lastIndexOf(0x0a)
      if (lastNewline < 0) {
        this.partials.set(file, combined)
        continue
      }
      this.partials.set(file, combined.subarray(lastNewline + 1))
      for (const line of combined.subarray(0, lastNewline).toString('utf8').split('\n')) {
        const translated = named[2] === 'claude' ? translateClaudeLine(line) : translateCodexLine(line)
        for (const event of translated?.events ?? []) out.push({ ...event, agentId: named[1] })
      }
    }
    return out
  }
}
