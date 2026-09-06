import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Ledger } from './ledger'
import type { createRunAttachments } from './run-attachments'
import { assertOwnedDirectoryBoundary, captureOwnedDirectory, readOwnedFile } from './owned-tree'
import { MAX_CONTEXT_BYTES, MAX_CONTEXT_FILES, MAX_CONTEXT_FILE_BYTES } from '../shared/attachments'
import { MAX_STEERING_FILES, steeringAttachments, type SteeringAttachment } from '../shared/steering'

const IMAGE = /\.(png|jpe?g|webp|gif)$/i
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')

/** Immutable, portable message files. No caller supplies a destination path. */
export class SteeringAttachments {
  constructor(private ledger: Ledger, private drafts?: Pick<ReturnType<typeof createRunAttachments>, 'snapshot'>) {}

  prepare(loopId: string, ids: string[], existing: SteeringAttachment[]) {
    if (ids.length && !this.drafts) throw new Error('Attachment selection is unavailable.')
    const sources = ids.length ? this.drafts!.snapshot(ids) : []
    if (sources.length > MAX_STEERING_FILES) throw new Error('Attach up to 10 files per message.')
    if (existing.length + sources.length > MAX_CONTEXT_FILES || [...existing.map(file => file.bytes), ...sources.map(file => file.bytes.length)].reduce((sum, bytes) => sum + bytes, 0) > MAX_CONTEXT_BYTES) throw new Error('This run is limited to 100 steering files and 100 MB of attachments.')
    const files: SteeringAttachment[] = sources.map(source => {
      const id = crypto.randomUUID(), leaf = `file-${path.basename(source.name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100)}`
      return { id, sourceId: source.sourceId, name: source.name, kind: IMAGE.test(source.name) ? 'image' : 'file', bytes: source.bytes.length, sha256: hash(source.bytes), path: `.gauntlet-gamesmith/steering/${loopId}/${id}/${leaf}` }
    })
    return { files, publish: () => {
      if (!files.length) return
      this.ledger.assertLoopWorkspaceIdentity(loopId)
      const loop = this.ledger.getLoop(loopId)!
      files.forEach((file, index) => {
        let boundary = captureOwnedDirectory(loop.workspaceDir, loop.workspaceDir, loop)
        for (const segment of file.path.split('/').slice(0, -1)) {
          assertOwnedDirectoryBoundary(boundary)
          const next = path.join(boundary.path, segment)
          if (!fs.existsSync(next)) fs.mkdirSync(next, { mode: 0o700 })
          boundary = captureOwnedDirectory(loop.workspaceDir, next, loop)
        }
        assertOwnedDirectoryBoundary(boundary)
        const fd = fs.openSync(path.join(boundary.path, path.basename(file.path)), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
        try {
          assertOwnedDirectoryBoundary(boundary)
          fs.writeFileSync(fd, sources[index].bytes); fs.fsyncSync(fd)
          assertOwnedDirectoryBoundary(boundary)
        } finally { fs.closeSync(fd) }
        this.read(loopId, file)
      })
    } }
  }

  read(loopId: string, value: SteeringAttachment): Buffer {
    const [file] = steeringAttachments([value], loopId)
    this.ledger.assertLoopWorkspaceIdentity(loopId)
    const loop = this.ledger.getLoop(loopId)!
    const boundary = captureOwnedDirectory(loop.workspaceDir, path.join(loop.workspaceDir, path.dirname(file.path)), loop)
    const bytes = readOwnedFile(boundary, path.basename(file.path), MAX_CONTEXT_FILE_BYTES, 'Steering attachment')
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Steering attachment changed or is missing: ${file.name}`)
    return bytes
  }

  verify(loopId: string, files: SteeringAttachment[]): string[] {
    return steeringAttachments(files, loopId).map(file => {
      this.read(loopId, file)
      return path.join(this.ledger.getLoop(loopId)!.workspaceDir, file.path)
    })
  }
}
