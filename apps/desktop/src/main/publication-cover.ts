import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, session } from 'electron'
import { MIME, type GameArtifact } from '@gauntlet/publishing'
import {
  digest,
  normalizeCover,
  validateArtifact,
} from '@gauntlet/publishing/node'
import { readExactFileDescriptor } from './bounded-fd'

const ORIGIN = 'https://gamesmith-cover.invalid'
const WIDTH = 1280
const HEIGHT = 720
const READY = `(() => ({
  menu: document.documentElement.dataset.gamesmithCover || '',
  loaded: document.readyState === 'complete' && document.fonts.status === 'loaded' &&
    Array.from(document.images).every(image => image.complete)
}))()`

/** Render only the validated shipping bytes, with no app bridge, profile, or network. */
export async function capturePublicationMenu(
  artifact: GameArtifact,
  log: (text: string) => void,
): Promise<Buffer> {
  const files = new Map(
    validateArtifact(artifact).artifact.files.map((file) => [file.path, file]),
  )
  const isolated = session.fromPartition(`publication-cover-${randomUUID()}`, {
    cache: false,
  })
  let window: BrowserWindow | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  try {
    isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    isolated.setPermissionCheckHandler(() => false)
    isolated.on('will-download', (event) => event.preventDefault())
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      callback({
        cancel:
          url.origin !== ORIGIN && !['data:', 'blob:'].includes(url.protocol),
      })
    })
    isolated.protocol.handle('https', (request) => {
      const url = new URL(request.url)
      if (url.origin !== ORIGIN || request.method !== 'GET')
        return new Response(null, { status: 403 })
      let name: string
      try {
        name = decodeURIComponent(url.pathname.slice(1)) || 'index.html'
      } catch {
        return new Response(null, { status: 400 })
      }
      const file = files.get(name)
      if (!file) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(Buffer.from(file.data, 'base64')), {
        headers: {
          'Content-Type': MIME[name.split('.').at(-1)!.toLowerCase()],
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Access-Control-Allow-Origin': '*',
          'Content-Security-Policy':
            "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'self'",
        },
      })
    })
    window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      show: false,
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true,
        backgroundThrottling: false,
        offscreen: true,
      },
    })
    const contents = window.webContents
    contents.setAudioMuted(true)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    log('Capturing the main-menu cover from the saved game at 1280 × 720.')
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              'Main-menu cover capture timed out. Check that the saved game loads, then retry Preview game.',
            ),
          ),
        20000,
      )
    })
    const render = async () => {
      await window!.loadURL(`${ORIGIN}/index.html?gamesmithCapture=main-menu`)
      const loadedAt = Date.now()
      let signalled = false
      while (!disposed) {
        const state = (await contents.executeJavaScript(READY)) as {
          menu: string
          loaded: boolean
        }
        if (state.loaded && state.menu === 'ready') {
          signalled = true
          break
        }
        // Older saved rounds do not have the readiness hook. Leave their initial
        // screen untouched; never click Start and accidentally capture gameplay.
        if (state.loaded && !state.menu && Date.now() - loadedAt >= 3000) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (disposed) throw new Error('Cover capture stopped.')
      log(
        signalled
          ? 'The game reports its main menu is ready.'
          : 'This older round has no menu-ready signal; using its loaded startup screen for the default cover.',
      )
      // Give the compositor time to paint the readiness update, including WebGL.
      await new Promise((resolve) => setTimeout(resolve, 200))
      if (disposed) throw new Error('Cover capture stopped.')
      const image = await contents.capturePage(
        { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        { stayHidden: true, stayAwake: true },
      )
      if (image.isEmpty())
        throw new Error(
          'Main-menu capture was empty. Check the saved game and retry Preview game.',
        )
      return normalizeCover(
        image.resize({ width: WIDTH, height: HEIGHT }).toPNG(),
      )
    }
    return await Promise.race([render(), timeout])
  } finally {
    disposed = true
    clearTimeout(timer)
    if (window && !window.isDestroyed()) window.destroy()
    isolated.protocol.unhandle('https')
    await isolated.clearStorageData()
  }
}

/** Cache by shipping digest so retrying an animated menu does not create a new release. */
export async function withPublicationCover(
  artifact: GameArtifact,
  cacheDirectory: string,
  log: (text: string) => void,
): Promise<{ artifact: GameArtifact; coverPath: string }> {
  const source = validateArtifact(artifact)
  fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 })
  const cache = path.join(cacheDirectory, `menu-v1-${source.digest}.png`)
  let bytes: Buffer | null = null
  try {
    const fd = fs.openSync(
      cache,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    )
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error('Cover cache must be a regular file.')
      bytes = await normalizeCover(
        readExactFileDescriptor(fd, stat.size, 3 * 1024 * 1024, 'menu cover'),
      )
    } finally {
      fs.closeSync(fd)
    }
    log('Reusing the captured main-menu cover for this exact shipping build.')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  if (!bytes) {
    bytes = await capturePublicationMenu(source.artifact, log)
    const temporary = `${cache}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, cache)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
  // Do not overwrite a game asset, even if it uses our usual generated filename.
  const paths = new Set(
    source.artifact.files.map((file) => file.path.toLowerCase()),
  )
  let coverPath = 'gamesmith-main-menu.png'
  for (let suffix = 1; paths.has(coverPath.toLowerCase()); suffix++)
    coverPath = `gamesmith-main-menu-${suffix}.png`
  const completed = validateArtifact({
    ...source.artifact,
    files: [
      ...source.artifact.files,
      {
        path: coverPath,
        data: bytes.toString('base64'),
        sha256: digest(bytes),
      },
    ],
  }).artifact
  log(
    `Default cover captured: ${coverPath}. Any owner-selected cover is preserved.`,
  )
  return { artifact: completed, coverPath }
}
