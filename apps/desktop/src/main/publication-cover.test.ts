import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { digest, validateArtifact } from '@gauntlet/publishing/node'
import type { GameArtifact } from '@gauntlet/publishing'

const fake = vi.hoisted(() => ({
  options: null as any,
  partition: '',
  protocol: null as any,
  request: null as any,
  permission: null as any,
  permissionCheck: null as any,
  state: { menu: 'ready', loaded: true },
  load: vi.fn(),
  execute: vi.fn(),
  capture: vi.fn(),
  destroy: vi.fn(),
  unhandle: vi.fn(),
  clear: vi.fn(),
  windowOpen: vi.fn(),
  muted: vi.fn(),
  image: {
    isEmpty: (): boolean => false,
    resize: vi.fn(),
    toPNG: () => Buffer.from('menu-image'),
  },
}))
vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      fake.partition = partition
      return {
        setPermissionRequestHandler: (fn: unknown) => {
          fake.permission = fn
        },
        setPermissionCheckHandler: (fn: unknown) => {
          fake.permissionCheck = fn
        },
        on: vi.fn(),
        webRequest: {
          onBeforeRequest: (fn: unknown) => {
            fake.request = fn
          },
        },
        protocol: {
          handle: (_scheme: string, fn: unknown) => {
            fake.protocol = fn
          },
          unhandle: fake.unhandle,
        },
        clearStorageData: fake.clear,
      }
    },
  },
  BrowserWindow: class {
    webContents = Object.assign(new EventEmitter(), {
      setAudioMuted: fake.muted,
      setWindowOpenHandler: fake.windowOpen,
      executeJavaScript: fake.execute,
      capturePage: fake.capture,
    })
    constructor(options: unknown) {
      fake.options = options
    }
    loadURL = fake.load
    isDestroyed = () => false
    destroy = fake.destroy
  },
}))
vi.mock('@gauntlet/publishing/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gauntlet/publishing/node')>()),
  normalizeCover: async (bytes: Buffer) => bytes,
}))
import {
  capturePublicationMenu,
  withPublicationCover,
} from './publication-cover'

const artifact = (html = '<h1>Main menu</h1>'): GameArtifact => ({
  version: 1,
  sourceRevision: 'a'.repeat(40),
  files: [
    {
      path: 'index.html',
      data: Buffer.from(html).toString('base64'),
      sha256: digest(html),
    },
  ],
})
let root: string
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  fake.state = { menu: 'ready', loaded: true }
  fake.execute.mockImplementation(async () => fake.state)
  fake.load.mockResolvedValue(undefined)
  fake.capture.mockResolvedValue(fake.image)
  fake.image.resize.mockReturnValue(fake.image)
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-cover-'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('automatic main-menu cover', () => {
  it('rejects changed shipping bytes before launching the game', async () => {
    const source = artifact()
    source.files[0].sha256 = '0'.repeat(64)
    await expect(capturePublicationMenu(source, vi.fn())).rejects.toThrow(
      'checksum mismatch',
    )
    expect(fake.load).not.toHaveBeenCalled()
  })

  it('does not cache an empty capture', async () => {
    vi.spyOn(fake.image, 'isEmpty').mockReturnValue(true)
    const result = expect(
      withPublicationCover(artifact(), root, vi.fn()),
    ).rejects.toThrow('capture was empty')
    await vi.advanceTimersByTimeAsync(250)
    await result
    expect(fs.readdirSync(root)).toEqual([])
    expect(fake.destroy).toHaveBeenCalledOnce()
  })

  it('captures a ready menu without exposing the app or external network', async () => {
    const result = capturePublicationMenu(artifact(), vi.fn())
    await vi.advanceTimersByTimeAsync(250)
    expect(await result).toEqual(Buffer.from('menu-image'))
    expect(fake.load).toHaveBeenCalledWith(
      'https://gamesmith-cover.invalid/index.html?gamesmithCapture=main-menu',
    )
    expect(fake.options).toMatchObject({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        offscreen: true,
      },
    })
    expect(fake.options.webPreferences.preload).toBeUndefined()
    expect(fake.partition).not.toContain('persist:')
    expect(fake.windowOpen.mock.calls[0][0]()).toEqual({ action: 'deny' })
    const permission = vi.fn()
    fake.permission(null, 'media', permission)
    expect(permission).toHaveBeenCalledWith(false)
    expect(fake.permissionCheck()).toBe(false)
    for (const url of [
      'https://elsewhere.test/',
      'http://127.0.0.1:1234/',
      'file:///private/file',
      'wss://elsewhere.test/',
    ]) {
      const reply = vi.fn()
      fake.request({ url }, reply)
      expect(reply).toHaveBeenCalledWith({ cancel: true })
    }
    const response = fake.protocol(
      new Request('https://gamesmith-cover.invalid/index.html'),
    )
    expect(await response.text()).toBe('<h1>Main menu</h1>')
    expect(response.headers.get('content-security-policy')).toContain(
      'sandbox allow-scripts',
    )
    expect(
      fake.protocol(
        new Request('https://gamesmith-cover.invalid/not-in-artifact.txt'),
      ).status,
    ).toBe(404)
    expect(
      fake.protocol(new Request('https://elsewhere.test/index.html')).status,
    ).toBe(403)
    expect(fake.destroy).toHaveBeenCalledOnce()
    expect(fake.unhandle).toHaveBeenCalledWith('https')
    expect(fake.clear).toHaveBeenCalledOnce()
  })

  it('waits for a declared loading menu instead of capturing the splash screen', async () => {
    fake.state.menu = 'loading'
    const log = vi.fn(),
      result = capturePublicationMenu(artifact(), log)
    await vi.advanceTimersByTimeAsync(4000)
    expect(fake.capture).not.toHaveBeenCalled()
    fake.state.menu = 'ready'
    await vi.advanceTimersByTimeAsync(400)
    await result
    expect(log).toHaveBeenCalledWith('The game reports its main menu is ready.')
  })

  it('automatically captures the loaded startup screen for older rounds', async () => {
    fake.state.menu = ''
    const log = vi.fn(),
      result = capturePublicationMenu(artifact(), log)
    await vi.advanceTimersByTimeAsync(2800)
    expect(fake.capture).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    await result
    expect(log.mock.calls.flat().join('\n')).toContain(
      'older round has no menu-ready signal',
    )
  })

  it('times out and closes the isolated window when a menu never becomes ready', async () => {
    fake.state.menu = 'loading'
    const result = expect(
      capturePublicationMenu(artifact(), vi.fn()),
    ).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(20001)
    await result
    expect(fake.capture).not.toHaveBeenCalled()
    expect(fake.destroy).toHaveBeenCalledOnce()
    expect(fake.clear).toHaveBeenCalledOnce()
  })

  it('cleans up on a load failure without caching a misleading cover', async () => {
    fake.load.mockRejectedValue(new Error('load failed'))
    await expect(
      withPublicationCover(artifact(), root, vi.fn()),
    ).rejects.toThrow('load failed')
    expect(fs.readdirSync(root)).toEqual([])
    expect(fake.destroy).toHaveBeenCalledOnce()
    expect(fake.clear).toHaveBeenCalledOnce()
  })

  it('adds a checked cover without overwriting game assets, and reuses it on retry', async () => {
    const source = artifact()
    source.files.push({
      path: 'gamesmith-main-menu.png',
      data: Buffer.from('existing').toString('base64'),
      sha256: digest('existing'),
    })
    const first = withPublicationCover(source, root, vi.fn())
    await vi.advanceTimersByTimeAsync(250)
    const result = await first
    expect(result.coverPath).toBe('gamesmith-main-menu-1.png')
    expect(
      result.artifact.files.find(
        (file) => file.path === 'gamesmith-main-menu.png',
      )?.data,
    ).toBe(Buffer.from('existing').toString('base64'))
    expect(validateArtifact(result.artifact).artifact.files).toHaveLength(3)
    const retry = await withPublicationCover(source, root, vi.fn())
    expect(retry).toEqual(result)
    expect(fake.capture).toHaveBeenCalledOnce()
    const changed = withPublicationCover(
      artifact('<h1>New menu</h1>'),
      root,
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(250)
    await changed
    expect(fake.capture).toHaveBeenCalledTimes(2)
  })
})
