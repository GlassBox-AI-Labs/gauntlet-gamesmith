import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
}

/**
 * Loopback media server for critique screenshots and gameplay video.
 * URL shape: http://127.0.0.1:<port>/<token>/<loopId>/<relPath>, where relPath
 * must stay inside the loop workspace's critique/ or reference/ directories.
 */
export function startMediaServer(resolveWorkspace: (loopId: string) => string | null): Promise<string> {
  const token = crypto.randomUUID()
  const server = http.createServer((req, res) => {
    const deny = (status: number): void => {
      res.writeHead(status)
      res.end()
    }
    try {
      const parts = decodeURIComponent((req.url ?? '').split('?')[0])
        .split('/')
        .filter(Boolean)
      const [reqToken, loopId, ...rest] = parts
      const rel = rest.join('/')
      const workspace = reqToken === token ? resolveWorkspace(loopId) : null
      const ext = path.extname(rel).toLowerCase()
      if (!workspace || !/^(critique|reference)\//.test(rel) || rel.includes('..') || !MIME[ext]) return deny(404)
      const file = path.join(workspace, rel)
      if (!file.startsWith(workspace)) return deny(403)
      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
      } catch {
        return deny(404)
      }
      const headers: Record<string, string> = { 'Content-Type': MIME[ext], 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]))
        const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
        if (start > end || start >= stat.size) return deny(416)
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1) })
        fs.createReadStream(file, { start, end }).pipe(res)
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': String(stat.size) })
        fs.createReadStream(file).pipe(res)
      }
    } catch {
      deny(500)
    }
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(`http://127.0.0.1:${address.port}/${token}`)
      else reject(new Error('Media server failed to bind.'))
    })
  })
}
