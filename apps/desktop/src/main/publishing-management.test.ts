import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ledger } from './ledger'
const electron = vi.hoisted(() => ({
  root: '',
  open: vi.fn(),
  confirm: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => electron.root },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (s: Buffer) => s.toString(),
  },
  shell: { openExternal: electron.open },
  dialog: { showMessageBox: electron.confirm },
  BrowserWindow: { getAllWindows: () => [] },
}))
import { Publishing } from './publishing'
const publisher = {
  id: '11111111-1111-4111-8111-111111111111',
  display_name: 'Test owner',
  handle: 'owner',
}
const gameId = '22222222-2222-4222-8222-222222222222'
const otherGameId = '22222222-2222-4222-8222-222222222223'
const releaseId = '33333333-3333-4333-8333-333333333333'
const buildId = '44444444-4444-4444-8444-444444444444'
const game = {
  id: gameId,
  publisher_id: publisher.id,
  slug: 'game',
  generation: 2,
  current_release_id: releaseId,
}
const release = {
  id: releaseId,
  game_id: gameId,
  digest: 'a'.repeat(64),
  status: 'ready',
  base_generation: 0,
  error: null,
  created_at: '2026-09-07T12:00:00Z',
  source: {
    loopId: buildId,
    runId: buildId,
    round: 1,
    revision: 'a'.repeat(40),
  },
  listing: {
    title: 'Game',
    slug: 'game',
    description: 'Original',
    controls: '',
    coverPath: null,
  },
}
const credentials = {
  access_token: 'fake-access',
  refresh_token: 'fake-refresh',
}
let studio: {
  publisher: typeof publisher
  games: (typeof game)[]
  releases: (typeof release)[]
}
let requests: { route: string; input: any }[]
let intercept: ((route: string) => Promise<unknown> | undefined) | undefined
let service: Publishing
beforeEach(async () => {
  electron.root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'publisher-management-'),
  )
  electron.open.mockReset()
  electron.confirm.mockResolvedValue({ response: 1 })
  vi.stubEnv('GAUNTLET_CATALOG_URL', 'http://127.0.0.1:3000')
  vi.stubEnv('GAUNTLET_GAME_ORIGIN', 'http://127.0.0.1:3001')
  studio = {
    publisher,
    games: [
      { ...game },
      {
        ...game,
        id: otherGameId,
        slug: 'unpublished',
        current_release_id: null,
      } as any,
    ],
    releases: [{ ...release }],
  }
  requests = []
  intercept = undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const route = String(url).split('/api/')[1]
      requests.push({
        route,
        input: init.body ? JSON.parse(String(init.body)) : undefined,
      })
      const intercepted = intercept?.(route)
      const body = intercepted
        ? await intercepted
        : route === 'login'
          ? { ...credentials, publisher }
          : route === 'refresh'
            ? credentials
            : route === 'me'
              ? studio
              : route === 'preview'
                ? {
                    url: `http://127.0.0.1:3001/preview/${releaseId}/private/index.html`,
                  }
                : {}
      return Response.json(body)
    }),
  )
  service = new Publishing(
    { getBuild: () => null } as unknown as Ledger,
    vi.fn(),
  )
  await service.signIn({
    email: 'fixture@example.com',
    password: 'test-only-password',
  })
  requests = []
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fs.rmSync(electron.root, { recursive: true, force: true })
})
describe('account-wide publishing management', () => {
  it('lists every owned game, including unpublished games without local jobs', async () => {
    const library = await service.library()
    expect(library.games.map((g) => g.gameId)).toEqual([gameId, otherGameId])
    expect(library.games[0].releases[0]).toMatchObject({
      round: 1,
      revision: 'a'.repeat(40),
      buildId,
    })
    expect(library.games[1].currentReleaseId).toBeNull()
    expect(JSON.stringify(library)).not.toContain('fake-access')
    expect((await service.history(buildId)).gameId).toBe(gameId)
  })
  it('previews and promotes an uploaded game without its original local build', async () => {
    await expect(
      service.publish({ gameId, releaseId, generation: 2 }),
    ).rejects.toThrow('Preview')
    const preview = await service.previewRelease({ gameId, releaseId })
    expect(electron.open).toHaveBeenCalledOnce()
    await service.publish(preview)
    expect(requests.find((r) => r.route === 'promote')?.input).toEqual({
      gameId,
      releaseId,
      generation: 2,
    })
  })
  it('rejects wrong-game releases and stale previews before promotion', async () => {
    await expect(
      service.previewRelease({ gameId: otherGameId, releaseId }),
    ).rejects.toThrow('ready release')
    const preview = await service.previewRelease({ gameId, releaseId })
    studio.games[0].generation++
    await expect(service.publish(preview)).rejects.toThrow('Preview')
    expect(requests.some((r) => r.route === 'promote')).toBe(false)
  })
  it('confirms unpublish and preserves state on cancellation', async () => {
    electron.confirm.mockResolvedValueOnce({ response: 0 })
    await service.unpublish({ gameId, generation: 2 })
    expect(requests.some((r) => r.route === 'promote')).toBe(false)
    await service.unpublish({ gameId, generation: 2 })
    expect(
      requests.find((r) => r.route === 'promote')?.input.releaseId,
    ).toBeNull()
  })
  it('saves listing metadata without needing any local source or cover upload', async () => {
    await service.updateListing({
      gameId,
      generation: 2,
      description: 'Edited',
      controls: 'Space',
    })
    expect(requests.find((r) => r.route === 'listing')?.input).toEqual({
      gameId,
      generation: 2,
      description: 'Edited',
      controls: 'Space',
    })
    expect(
      requests.some(
        (r) => r.route === 'covers/upload' || r.route === 'releases',
      ),
    ).toBe(false)
    await expect(
      service.updateListing({
        gameId,
        generation: -1,
        description: '',
        controls: '',
      }),
    ).rejects.toThrow()
    await expect(
      service.updateListing({
        gameId,
        generation: 2,
        description: '',
        controls: '',
        coverSelectionId: buildId,
      }),
    ).rejects.toThrow('Select the cover again')
  })
  it('does not restore a signed-out session when an earlier refresh finishes', async () => {
    let complete!: (value: unknown) => void
    intercept = (route) =>
      route === 'refresh'
        ? new Promise((resolve) => {
            complete = resolve
          })
        : undefined
    const pending = service.library()
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    service.signOut()
    complete(credentials)
    await expect(pending).rejects.toThrow('account changed')
    expect((await service.library()).status.connected).toBe(false)
  })
  it('discards an account read that finishes after sign-out', async () => {
    let complete!: (value: unknown) => void
    intercept = (route) =>
      route === 'me'
        ? new Promise((resolve) => {
            complete = resolve
          })
        : undefined
    const pending = service.library()
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    service.signOut()
    complete(studio)
    await expect(pending).rejects.toThrow('account changed')
  })
})

it('validates sign-in code requests and creates no session until verification succeeds', async () => {
  service.signOut()
  const email = 'person@challenger.gauntletai.com'
  await expect(
    service.sendSignInCode({ email: 'person@example.com' }),
  ).rejects.toThrow('approved email')
  expect(requests).toEqual([])
  await service.sendSignInCode({ email, extra: 'ignored' })
  expect(requests).toEqual([{ route: 'sign-in-code', input: { email } }])
  expect((await service.status()).connected).toBe(false)
  intercept = (route) =>
    route === 'verify-email'
      ? Promise.resolve({ ...credentials, publisher })
      : undefined
  const result = await service.verifyEmail({ email, code: '123456' })
  expect(result).toEqual({
    connected: true,
    catalogUrl: 'http://127.0.0.1:3000',
    publisherName: publisher.display_name,
  })
  expect(result).not.toHaveProperty('access_token')
  expect((await service.library()).games).toHaveLength(2)
})
