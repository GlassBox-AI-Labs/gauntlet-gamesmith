import { describe, expect, it } from 'vitest'
import { probeGameBoot, waitForGameBoot } from './play-boot'

function pages(map: Record<string, { status: number; body?: string; type?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const path = url.replace(/^https?:\/\/[^/]+/, '') || '/'
    const hit = map[path] ?? map[url]
    if (!hit) return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } })
    return new Response(hit.body ?? '', {
      status: hit.status,
      headers: { 'content-type': hit.type ?? 'text/javascript' },
    })
  }) as typeof fetch
}

const html = `<!DOCTYPE html><html><body>
<script type="module" src="/@vite/client"></script>
<script type="module" src="/src/main.js"></script>
</body></html>`

describe('probeGameBoot', () => {
  it('accepts a page whose entry module graph all returns 200', async () => {
    const fetchImpl = pages({
      '/': { status: 200, body: html, type: 'text/html' },
      '/src/main.js': { status: 200, body: 'console.log("ok")\n' },
    })

    await expect(probeGameBoot('http://127.0.0.1:5173/', fetchImpl)).resolves.toEqual({ ok: true })
  })

  it('fails when a vendor chunk is rewritten to a missing .ts URL — the blank Play page', async () => {
    const fetchImpl = pages({
      '/': { status: 200, body: html, type: 'text/html' },
      '/src/main.js': {
        status: 200,
        body: 'import RAPIER from "/node_modules/.vite/deps/@dimforge_rapier3d-compat.js?v=1";\nawait RAPIER.init();\n',
      },
      '/node_modules/.vite/deps/@dimforge_rapier3d-compat.js?v=1': {
        status: 200,
        body: 'import "/node_modules/.vite/deps/chunk-BUSYA2B4.ts?v=1";\nexport default { init() {} }\n',
      },
    })

    const result = await probeGameBoot('http://127.0.0.1:5173/', fetchImpl)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('404')
    expect(result.error).toContain('chunk-BUSYA2B4.ts')
  })

  it('fails when index.html has no module script, which is also a blank page', async () => {
    const fetchImpl = pages({
      '/': { status: 200, body: '<!DOCTYPE html><html><body></body></html>', type: 'text/html' },
    })

    const result = await probeGameBoot('http://127.0.0.1:5173/', fetchImpl)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/no module script/i)
  })

  it('does not treat a 404 on an other-origin stylesheet as a boot failure', async () => {
    const fetchImpl = pages({
      '/': {
        status: 200,
        body: `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">
</head><body><script type="module" src="/src/main.js"></script></body></html>`,
        type: 'text/html',
      },
      '/src/main.js': { status: 200, body: 'export {}\n' },
    })

    await expect(probeGameBoot('http://127.0.0.1:5173/', fetchImpl)).resolves.toEqual({ ok: true })
  })
})

describe('waitForGameBoot', () => {
  it('retries a connection refusal, then accepts the page once Vite is listening', async () => {
    let calls = 0
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return pages({
        '/': { status: 200, body: html, type: 'text/html' },
        '/src/main.js': { status: 200, body: 'export {}\n' },
      })(input)
    }) as typeof fetch

    const result = await waitForGameBoot('http://127.0.0.1:5173/', fetchImpl, {
      timeoutMs: 1000,
      sleep: async () => undefined,
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toBeGreaterThan(1)
  })

  it('does not retry a 404 — that is the game, not a slow bind', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response('no', { status: 404, headers: { 'content-type': 'text/plain' } })
    }) as typeof fetch

    const result = await waitForGameBoot('http://127.0.0.1:5173/', fetchImpl, {
      timeoutMs: 1000,
      sleep: async () => undefined,
    })

    expect(result.ok).toBe(false)
    expect(calls).toBe(1)
  })
})
