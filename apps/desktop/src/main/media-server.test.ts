import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMediaServer, MediaBaseGate, mediaBaseReadiness, resolveMediaFile, type MediaServerHandle } from './media-server'

const tempDirs: string[] = []
const servers: MediaServerHandle[] = []

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-media-'))
  tempDirs.push(dir)
  fs.mkdirSync(path.join(dir, 'critique', 'round-1', 'shots'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'reference', 'images'), { recursive: true })
  return dir
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: response.headers }))
    }).on('error', reject)
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('media server', () => {
  it('settles startup readiness for both successful and failed listeners', async () => {
    await expect(mediaBaseReadiness(async () => 'http://127.0.0.1:1234/token')).resolves.toEqual({
      ok: true,
      value: 'http://127.0.0.1:1234/token',
    })
    await expect(mediaBaseReadiness(async () => { throw new Error(`bind denied ghp_${'a'.repeat(36)}`) })).resolves.toEqual({
      ok: false,
      error: 'Media server failed to start: bind denied [REDACTED]',
    })
  })

  it('surfaces one startup failure, then serializes a successful retry', async () => {
    let attempts = 0
    const gate = new MediaBaseGate(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('first bind denied')
      return 'http://127.0.0.1:1234/token'
    })

    await expect(gate.get()).resolves.toEqual({ ok: false, error: 'Media server failed to start: first bind denied' })
    const [first, second] = await Promise.all([gate.get(), gate.get()])
    expect(first).toEqual({ ok: true, value: 'http://127.0.0.1:1234/token' })
    expect(second).toEqual(first)
    expect(attempts).toBe(2)
  })
  it('serves an authenticated artifact and honors a bounded byte range', async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'critique', 'round-1', 'shots', 'frame.png'), '0123456789')
    const server = await createMediaServer((buildId) => (buildId === 'build-1' ? dir : null))
    servers.push(server)

    const whole = await get(`${server.baseUrl}/build-1/critique/round-1/shots/frame.png`)
    expect(whole).toMatchObject({ status: 200, body: '0123456789' })
    const partial = await get(`${server.baseUrl}/build-1/critique/round-1/shots/frame.png`, { Range: 'bytes=2-5' })
    expect(partial).toMatchObject({ status: 206, body: '2345' })
    expect(partial.headers['content-range']).toBe('bytes 2-5/10')
  })

  it('rejects a wrong token, traversal, and malformed ranges', async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'reference', 'images', 'frame.png'), 'image')
    const server = await createMediaServer(() => dir)
    servers.push(server)
    const url = `${server.baseUrl}/build-1/reference/images/frame.png`

    expect((await get(url.replace(/\/[^/]+\/build-1/, '/wrong-token/build-1'))).status).toBe(404)
    expect((await get(`${server.baseUrl}/build-1/reference/%2e%2e/package.png`)).status).toBe(404)
    expect((await get(url, { Range: 'bytes=9-2' })).status).toBe(416)
    expect((await get(url, { Range: 'bytes=wat' })).status).toBe(416)
  })

  it('rejects symlinks and hard links that escape artifact ownership', () => {
    const dir = workspace()
    const secret = path.join(path.dirname(dir), `${path.basename(dir)}-secret.png`)
    fs.writeFileSync(secret, 'not an artifact')
    fs.symlinkSync(secret, path.join(dir, 'reference', 'images', 'escape.png'))

    expect(resolveMediaFile(dir, 'reference/images/escape.png')).toBeNull()
    fs.unlinkSync(path.join(dir, 'reference', 'images', 'escape.png'))
    fs.linkSync(secret, path.join(dir, 'reference', 'images', 'escape.png'))
    expect(resolveMediaFile(dir, 'reference/images/escape.png')).toBeNull()
    fs.rmSync(secret, { force: true })
  })

  it('rejects an artifact root symlink and oversized sparse media before opening it', () => {
    const dir = workspace()
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside-reference`)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'escape.png'), 'not an artifact')
    fs.rmSync(path.join(dir, 'reference'), { recursive: true })
    fs.symlinkSync(outside, path.join(dir, 'reference'))
    expect(resolveMediaFile(dir, 'reference/escape.png')).toBeNull()

    fs.rmSync(path.join(dir, 'reference'))
    fs.mkdirSync(path.join(dir, 'reference', 'images'), { recursive: true })
    const oversized = path.join(dir, 'reference', 'images', 'oversized.mp4')
    fs.writeFileSync(oversized, '')
    fs.truncateSync(oversized, 512 * 1024 * 1024 + 1)
    expect(resolveMediaFile(dir, 'reference/images/oversized.mp4')).toBeNull()
    const oversizedImage = path.join(dir, 'reference', 'images', 'oversized.png')
    fs.writeFileSync(oversizedImage, '')
    fs.truncateSync(oversizedImage, 32 * 1024 * 1024 + 1)
    expect(resolveMediaFile(dir, 'reference/images/oversized.png')).toBeNull()
    fs.rmSync(outside, { recursive: true })
  })
})
