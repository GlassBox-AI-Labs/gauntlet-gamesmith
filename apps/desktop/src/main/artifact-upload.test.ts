import { it, expect, vi } from 'vitest'
import { uploadArtifact } from './artifact-upload'
it('replays the complete artifact after a lost response without sending partial JSON', async () => {
  const artifact = { version: 1, sourceRevision: 'a'.repeat(40), files: [{ path: 'index.html', data: 'PHAvPg==', sha256: 'b'.repeat(64) }] } as const
  const received: unknown[] = []
  const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
    received.push(await new Response(init!.body).json())
    if (received.length === 1) throw new TypeError('network disconnected')
    return new Response(null, { status: 409 })
  })
  const log = vi.fn()
  await uploadArtifact(new URL('https://storage.example/upload'), { ...artifact, files: [...artifact.files] }, log, send as typeof fetch)
  expect(received).toEqual([artifact, artifact])
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Retrying automatically'))
})
