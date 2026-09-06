import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { OperationResult } from '../shared/result'
import { redactedErrorMessage } from '../shared/redact-log'
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from './media-limits'
import { captureOwnedDirectory, ownedFileStat } from './owned-tree'
import type { WorkspaceRootIdentity } from './workspace-boundary'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
}

function mediaLimit(mime: string): number {
  return mime.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES
}

/** Resolve only real, regular media files contained by a real artifact root. */
export function resolveMediaFile(
  workspace: string | WorkspaceRootIdentity,
  relativePath: string,
): { file: string; mime: string; size: number; dev: number; ino: number } | null {
  if (relativePath.length === 0 || relativePath.length > 4_096 || relativePath.includes('\\') || relativePath.includes('\0')) return null
  const segments = relativePath.split('/')
  const rootName = segments.shift()
  if ((rootName !== 'critique' && rootName !== 'reference' && rootName !== '.img2threejs') || segments.length === 0) return null
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  const mime = MIME[path.extname(segments.at(-1)!).toLowerCase()]
  if (!mime) return null

  try {
    const workspaceDir = typeof workspace === 'string' ? workspace : workspace.workspaceDir
    const expected = typeof workspace === 'string' ? undefined : workspace
    let directory = captureOwnedDirectory(workspaceDir, path.join(workspaceDir, rootName), expected)
    for (const segment of segments.slice(0, -1)) {
      directory = captureOwnedDirectory(directory.ownerRoot, path.join(directory.path, segment), expected)
    }
    const leaf = segments.at(-1)!
    const stat = ownedFileStat(directory, leaf)
    if (stat.size > mediaLimit(mime)) return null
    const file = path.join(directory.path, leaf)
    return { file, mime, size: stat.size, dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

export interface MediaServerHandle {
  baseUrl: string
  close(): Promise<void>
}

/**
 * Loopback media server for critique screenshots and gameplay video.
 * URL shape: http://127.0.0.1:<port>/<token>/<loopId>/<relPath>, where relPath
 * must stay inside the loop workspace's critique/, reference/, or sculptor
 * evidence directories. Project source is never served or executed here.
 */
export function createMediaServer(resolveWorkspace: (loopId: string) => string | WorkspaceRootIdentity | null): Promise<MediaServerHandle> {
  const token = crypto.randomUUID()
  const server = http.createServer((req, res) => {
    let descriptor: number | null = null
    const deny = (status: number): void => {
      res.writeHead(status)
      res.end()
    }
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405)
      let decoded: string
      try {
        decoded = decodeURIComponent((req.url ?? '').split('?')[0])
      } catch {
        return deny(404)
      }
      const parts = decoded.split('/').filter(Boolean)
      const [reqToken, loopId, ...rest] = parts
      const workspace = reqToken === token && loopId ? resolveWorkspace(loopId) : null
      const resolved = workspace ? resolveMediaFile(workspace, rest.join('/')) : null
      if (!resolved) return deny(404)

      try {
        descriptor = fs.openSync(resolved.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        const live = fs.fstatSync(descriptor)
        if (!live.isFile() || live.nlink !== 1 || live.size > mediaLimit(resolved.mime) || live.dev !== resolved.dev || live.ino !== resolved.ino) {
          fs.closeSync(descriptor)
          descriptor = null
          return deny(404)
        }
      } catch {
        if (descriptor !== null) fs.closeSync(descriptor)
        return deny(404)
      }
      const denyOpened = (status: number): void => {
        if (descriptor !== null) fs.closeSync(descriptor)
        descriptor = null
        deny(status)
      }

      const headers: Record<string, string> = {
        'Content-Type': resolved.mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      }
      const rangeHeader = req.headers.range
      const range = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null
      if (rangeHeader && (!range || (!range[1] && !range[2]))) return denyOpened(416)
      if (range) {
        const start = range[1] ? Number(range[1]) : Math.max(0, resolved.size - Number(range[2]))
        const end = range[1] && range[2] ? Math.min(Number(range[2]), resolved.size - 1) : resolved.size - 1
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= resolved.size) return denyOpened(416)
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${resolved.size}`,
          'Content-Length': String(end - start + 1),
        })
        if (req.method === 'HEAD') {
          fs.closeSync(descriptor)
          descriptor = null
          return res.end()
        }
        const stream = fs.createReadStream(resolved.file, { fd: descriptor, autoClose: true, start, end })
        descriptor = null
        stream.on('error', () => res.destroy())
        stream.pipe(res)
        return
      }
      res.writeHead(200, { ...headers, 'Content-Length': String(resolved.size) })
      if (req.method === 'HEAD' || resolved.size === 0) {
        fs.closeSync(descriptor)
        descriptor = null
        return res.end()
      }
      const stream = fs.createReadStream(resolved.file, {
        fd: descriptor,
        autoClose: true,
        start: 0,
        end: resolved.size - 1,
      })
      descriptor = null
      stream.on('error', () => res.destroy())
      stream.pipe(res)
    } catch {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor)
        } catch {
          /* already closed while rejecting the request */
        }
      }
      deny(500)
    }
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address !== 'object') return reject(new Error('Media server failed to bind.'))
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/${token}`,
        close: () => new Promise<void>((done, closeReject) => server.close((error) => (error ? closeReject(error) : done()))),
      })
    })
  })
}

export async function startMediaServer(resolveWorkspace: (loopId: string) => string | WorkspaceRootIdentity | null): Promise<string> {
  return (await createMediaServer(resolveWorkspace)).baseUrl
}

/** Keep startup rejection observed and let IPC await one settled readiness value. */
export function mediaBaseReadiness(start: () => Promise<string>): Promise<OperationResult<string>> {
  return start().then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({
      ok: false,
      error: `Media server failed to start: ${redactedErrorMessage(error, 'Unknown media startup failure.')}`,
    }),
  )
}

/**
 * Serialize media startup and retry only after the renderer has observed the
 * prior failure. Concurrent IPC callers share one attempt and a live server
 * is never started twice.
 */
export class MediaBaseGate {
  private current: Promise<OperationResult<string>>
  private retrying: Promise<OperationResult<string>> | null = null
  private failureDelivered = false

  constructor(private readonly start: () => Promise<string>) {
    this.current = mediaBaseReadiness(start)
  }

  async get(): Promise<OperationResult<string>> {
    if (this.retrying) return await this.retrying
    const current = await this.current
    if (current.ok) return current
    if (!this.failureDelivered) {
      this.failureDelivered = true
      return current
    }
    if (this.retrying) return await this.retrying
    const retry = mediaBaseReadiness(this.start)
    this.retrying = retry
    this.current = retry
    try {
      return await retry
    } finally {
      if (this.retrying === retry) this.retrying = null
    }
  }
}
