import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MultiplayerCatalog } from './multiplayer'
import { MultiplayerServer, type RoomStore } from '@glassbox/multiplayer/server'
import type { Catalog } from './catalog'
const gameId = randomUUID(), releaseId = randomUUID(), secret = 'a'.repeat(64)
function fixture() {
  const catalog = {
    release: vi.fn(async () => ({ id: releaseId, game_id: gameId, status: 'ready' })),
    game: vi.fn(async () => ({ current_release_id: releaseId })),
    validPreview: vi.fn((_id: string, token: string) => token === 'valid'),
    artifact: vi.fn(async () => ({ files: [{ path: 'gamesmith.multiplayer.json', data: Buffer.from(JSON.stringify({ version: 1, mode: 'relay' })).toString('base64') }] })),
  }
  const store = { limit: vi.fn(async () => true) }
  const server = new MultiplayerServer(store as unknown as RoomStore, secret, 'wss://games.example/socket')
  const join = vi.spyOn(server, 'join').mockResolvedValue({} as never)
  return { catalog, store, join, api: new MultiplayerCatalog(catalog as unknown as Catalog, server, secret) }
}
const input = { action: 'join', gameId, releaseId, name: 'Guest' }
describe('release-bound guest access', () => {
  it('allows public guests and capability previews in distinct scopes', async () => {
    const { api, join, catalog } = fixture()
    await api.request(input, 'client')
    const publicScope = join.mock.calls[0][0].scope
    catalog.game.mockResolvedValue({ current_release_id: null } as never)
    await api.request({ ...input, previewToken: 'valid' }, 'client')
    expect(join.mock.calls[1][0].scope).not.toBe(publicScope)
    expect(join.mock.calls[1][0].manifest).toMatchObject({ sessionSeconds: 180, maxPlayers: 6 })
  })
  it('rejects unpublished, mismatched, unready and invalid-preview releases before joining', async () => {
    const { api, catalog, join } = fixture()
    catalog.game.mockResolvedValue({ current_release_id: null } as never)
    await expect(api.request(input, 'client')).rejects.toThrow('unavailable')
    await expect(api.request({ ...input, previewToken: 'wrong' }, 'client')).rejects.toThrow('expired')
    catalog.release.mockResolvedValue({ id: releaseId, game_id: randomUUID(), status: 'ready' })
    await expect(api.request(input, 'client')).rejects.toThrow('unavailable')
    catalog.release.mockResolvedValue({ id: releaseId, game_id: gameId, status: 'pending' })
    await expect(api.request(input, 'client')).rejects.toThrow('unavailable')
    expect(join).not.toHaveBeenCalled()
  })
  it('rejects malformed requests, missing declarations, and rate-limited guests', async () => {
    const { api, catalog, store, join } = fixture()
    await expect(api.request({ ...input, gameId: 'no' }, 'client')).rejects.toThrow()
    catalog.artifact.mockResolvedValue({ files: [] })
    await expect(api.request(input, 'client')).rejects.toThrow('does not support')
    store.limit.mockResolvedValue(false)
    await expect(api.request(input, 'client')).rejects.toThrow('Too many')
    expect(join).not.toHaveBeenCalled()
  })
})
