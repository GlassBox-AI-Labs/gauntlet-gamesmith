import { Readable } from 'node:stream'
import type { GameArtifact } from '@gauntlet/publishing'

/** A new stream per attempt preserves signed-upload idempotency after an interrupted transfer. */
export async function uploadArtifact(url: URL, artifact: GameArtifact, log: (text: string) => void, send: typeof fetch = fetch): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let transferred = 0, reported = 0
    function* parts() {
      yield `{"version":1,"sourceRevision":${JSON.stringify(artifact.sourceRevision)},"files":[`
      for (let index = 0; index < artifact.files.length; index++) {
        if (index) yield ','
        yield JSON.stringify(artifact.files[index])
      }
      yield ']}'
    }
    function* chunks() {
      for (const part of parts()) {
        const bytes = Buffer.from(part)
        for (let start = 0; start < bytes.length; start += 64 * 1024) {
          const chunk = bytes.subarray(start, start + 64 * 1024)
          transferred += chunk.length
          if (transferred - reported >= 1024 * 1024) {
            reported = transferred
            log(`Sending game files: ${(transferred / 1024 / 1024).toFixed(1)} MB (attempt ${attempt}/3).`)
          }
          yield chunk
        }
      }
    }
    let retry = false
    try {
      const response = await send(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: Readable.toWeb(Readable.from(chunks())) as ReadableStream<Uint8Array>,
        duplex: 'half', signal: AbortSignal.timeout(120000),
      } as RequestInit)
      await response.body?.cancel()
      // A previous attempt may have reached storage despite a lost response. The
      // authenticated complete endpoint verifies the stored artifact digest next.
      if (response.ok || response.status === 409 || response.status === 400) return
      retry = response.status === 408 || response.status === 429 || response.status >= 500
      if (!retry) throw new Error('Storage rejected the transfer. Retry this saved round to renew its upload.')
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Storage rejected')) throw error
      retry = true
    }
    if (retry && attempt < 3) {
      log(`Game upload was interrupted. Retrying automatically (${attempt + 1}/3); the saved round is unchanged.`)
      await new Promise(resolve => setTimeout(resolve, attempt * 1000))
    }
  }
  throw new Error('Game upload is temporarily unavailable. Retry this saved round; your game and listing are saved.')
}
