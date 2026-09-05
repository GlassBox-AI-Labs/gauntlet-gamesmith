/**
 * Confirm the Play URL actually boots. Vite printing a local address is not
 * enough: a resolve plugin can 404 vendor chunks and leave a blank page.
 */

export type BootProbe = { ok: true } | { ok: false; error: string }

const IMPORT_RE = /(?:from|import)\s*\(\s*['"]([^'"]+)['"]|(?:from|import)\s+['"]([^'"]+)['"]/g
const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi
const DEFAULT_MAX_FILES = 60

export interface WaitForGameBootOptions {
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  maxFiles?: number
}

function originOf(url: string): string {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.host}`
}

function resolveSpecifier(from: string, spec: string): string | null {
  if (!spec || spec.startsWith('data:') || spec.startsWith('blob:')) return null
  if (spec.startsWith('http://') || spec.startsWith('https://')) return spec
  try {
    return new URL(spec, from).href
  } catch {
    return null
  }
}

function isAppModule(url: string): boolean {
  try {
    const path = new URL(url).pathname
    return !path.startsWith('/@vite/') && !path.startsWith('/@id/') && !path.startsWith('/@fs/')
  } catch {
    return true
  }
}

function isScript(url: string, contentType: string): boolean {
  if (/javascript|ecmascript|module/.test(contentType)) return true
  return /\.(m?js|ts|tsx|mts|cts)(\?|$)/i.test(url)
}

function isHtml(url: string, contentType: string): boolean {
  if (contentType.includes('text/html')) return true
  const path = (() => {
    try {
      return new URL(url).pathname
    } catch {
      return url
    }
  })()
  return path === '/' || path.endsWith('.html')
}

function specifiersIn(source: string): string[] {
  const out: string[] = []
  IMPORT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMPORT_RE.exec(source))) {
    const spec = match[1] ?? match[2]
    if (spec) out.push(spec)
  }
  return out
}

function scriptSrcs(html: string): string[] {
  const out: string[] = []
  SCRIPT_SRC_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SCRIPT_SRC_RE.exec(html))) {
    if (match[1]) out.push(match[1])
  }
  return out
}

function fail(url: string, detail: string): BootProbe {
  return { ok: false, error: `Game did not boot: ${detail} (${url})` }
}

export async function probeGameBoot(
  pageUrl: string,
  fetchImpl: typeof fetch = fetch,
  maxFiles = DEFAULT_MAX_FILES,
): Promise<BootProbe> {
  const origin = originOf(pageUrl)
  const queue: string[] = [pageUrl]
  const seen = new Set<string>()
  let fetched = 0
  let sawModuleScript = !isHtml(pageUrl, 'text/html')

  while (queue.length > 0 && fetched < maxFiles) {
    const url = queue.shift()!
    if (seen.has(url)) continue
    seen.add(url)
    if (!isAppModule(url)) continue
    if (originOf(url) !== origin) continue

    fetched += 1
    let response: Response
    try {
      response = await fetchImpl(url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(url, message)
    }
    if (!response.ok) return fail(url, `HTTP ${response.status}`)

    const type = response.headers.get('content-type') ?? ''
    if (isHtml(url, type)) {
      const body = await response.text()
      const srcs = scriptSrcs(body)
      if (srcs.some((src) => {
        const resolved = resolveSpecifier(url, src)
        return resolved != null && isAppModule(resolved)
      })) {
        sawModuleScript = true
      }
      for (const src of srcs) {
        const next = resolveSpecifier(url, src)
        if (next) queue.push(next)
      }
      continue
    }
    if (!isScript(url, type)) continue
    const body = await response.text()
    for (const spec of specifiersIn(body)) {
      const next = resolveSpecifier(url, spec)
      if (next) queue.push(next)
    }
  }

  if (!sawModuleScript) return fail(pageUrl, 'index.html has no module script')
  return { ok: true }
}

function isTransient(error: string): boolean {
  return /ECONNREFUSED|ECONNRESET|fetch failed|network|UND_ERR|timed out waiting/i.test(error)
}

export async function waitForGameBoot(
  pageUrl: string,
  fetchImpl: typeof fetch = fetch,
  opts: WaitForGameBootOptions = {},
): Promise<BootProbe> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + timeoutMs
  let last: BootProbe = { ok: false, error: `Game did not boot: timed out waiting for the dev server (${pageUrl})` }
  while (Date.now() < deadline) {
    last = await probeGameBoot(pageUrl, fetchImpl, opts.maxFiles)
    if (last.ok) return last
    if (!isTransient(last.error)) return last
    await sleep(200)
  }
  return last
}
