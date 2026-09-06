import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Ledger } from './ledger'
import type { createBuildAttachments } from './build-attachments'
import { assertOwnedDirectoryBoundary, captureOwnedDirectory, readOwnedFile } from './owned-tree'
import { MAX_CONTEXT_BYTES, MAX_CONTEXT_FILES, MAX_CONTEXT_FILE_BYTES } from '../shared/attachments'
import { MAX_STEERING_FILES, steeringAttachments, type SteeringAttachment } from '../shared/steering'

const IMAGE = /\.(png|jpe?g|webp|gif)$/i
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')

/** Immutable, portable message files. No caller supplies a destination path. */
export class SteeringAttachments {
  constructor(private ledger: Ledger, private drafts?: Pick<ReturnType<typeof createBuildAttachments>, 'snapshot'>) {}

  prepare(buildId: string, ids: string[], existing: SteeringAttachment[]) {
    if (ids.length && !this.drafts) throw new Error('Attachment selection is unavailable.')
    const sources = ids.length ? this.drafts!.snapshot(ids) : []
    if (sources.length > MAX_STEERING_FILES) throw new Error('Attach up to 10 files per message.')
    if (existing.length + sources.length > MAX_CONTEXT_FILES || [...existing.map(file => file.bytes), ...sources.map(file => file.bytes.length)].reduce((sum, bytes) => sum + bytes, 0) > MAX_CONTEXT_BYTES) throw new Error('This build is limited to 100 steering files and 100 MB of attachments.')
    const files: SteeringAttachment[] = sources.map(source => {
      const id = crypto.randomUUID(), leaf = `file-${path.basename(source.name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100)}`
      return { id, sourceId: source.sourceId, name: source.name, kind: IMAGE.test(source.name) ? 'image' : 'file', bytes: source.bytes.length, sha256: hash(source.bytes), path: `.gauntlet-gamesmith/steering/${buildId}/${id}/${leaf}` }
    })
    return { files, publish: () => {
      if (!files.length) return
      this.ledger.assertBuildWorkspaceIdentity(buildId)
      const build = this.ledger.getBuild(buildId)!
      files.forEach((file, index) => {
        let boundary = captureOwnedDirectory(build.workspaceDir, build.workspaceDir, build)
        for (const segment of file.path.split('/').slice(0, -1)) {
          assertOwnedDirectoryBoundary(boundary)
          const next = path.join(boundary.path, segment)
          if (!fs.existsSync(next)) fs.mkdirSync(next, { mode: 0o700 })
          boundary = captureOwnedDirectory(build.workspaceDir, next, build)
        }
        assertOwnedDirectoryBoundary(boundary)
        const fd = fs.openSync(path.join(boundary.path, path.basename(file.path)), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
        try {
          assertOwnedDirectoryBoundary(boundary)
          fs.writeFileSync(fd, sources[index].bytes); fs.fsyncSync(fd)
          assertOwnedDirectoryBoundary(boundary)
        } finally { fs.closeSync(fd) }
        this.read(buildId, file)
      })
    } }
  }

  read(buildId: string, value: SteeringAttachment): Buffer {
    const [file] = steeringAttachments([value], buildId)
    this.ledger.assertBuildWorkspaceIdentity(buildId)
    const build = this.ledger.getBuild(buildId)!
    const boundary = captureOwnedDirectory(build.workspaceDir, path.join(build.workspaceDir, path.dirname(file.path)), build)
    const bytes = readOwnedFile(boundary, path.basename(file.path), MAX_CONTEXT_FILE_BYTES, 'Steering attachment')
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Steering attachment changed or is missing: ${file.name}`)
    return bytes
  }

  verify(buildId: string, files: SteeringAttachment[]): string[] {
    return steeringAttachments(files, buildId).map(file => {
      this.read(buildId, file)
      return path.join(this.ledger.getBuild(buildId)!.workspaceDir, file.path)
    })
  }
}
