import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { createHash } from 'node:crypto'
import { normalizeCover } from '@gauntlet/publishing/node'
import { Catalog } from './catalog'
const actor = '11111111-1111-4111-8111-111111111111'
const gameId = '22222222-2222-4222-8222-222222222222'
const coverId = '33333333-3333-4333-8333-333333333333'
function fixture() {
  const game = {
    id: gameId,
    publisher_id: actor,
    slug: 'game',
    current_release_id: null,
    generation: 3,
  }
  const storage = {
    createSignedUploadUrl: vi.fn().mockResolvedValue({
      data: { signedUrl: 'https://storage.test/scoped' },
      error: null,
    }),
    download: vi.fn(),
    upload: vi.fn(),
  }
  const client = {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: game, error: null }) }),
      }),
    })),
    rpc: vi
      .fn()
      .mockResolvedValue({ data: { ...game, generation: 4 }, error: null }),
    storage: { from: vi.fn(() => storage) },
  }
  return {
    catalog: new Catalog(
      client as unknown as SupabaseClient<Database>,
      'a'.repeat(64),
      vi.fn(),
    ),
    client,
    storage,
  }
}
const edit = {
  gameId,
  generation: 3,
  description: 'New description',
  controls: 'Arrows',
}
describe('owner listing updates', () => {
  it('saves metadata through the transactional RPC without touching artifacts or releases', async () => {
    const { catalog, client } = fixture()
    expect((await catalog.updateListing(actor, edit)).generation).toBe(4)
    expect(client.rpc).toHaveBeenCalledWith('update_game_listing', {
      actor,
      target_game: gameId,
      expected_generation: 3,
      description: 'New description',
      controls: 'Arrows',
    })
    expect(client.storage.from).not.toHaveBeenCalled()
  })
  it('rejects another owner and stale generation before creating uploads or writing', async () => {
    const { catalog, client } = fixture()
    await expect(catalog.updateListing(coverId, edit)).rejects.toThrow('own')
    await expect(
      catalog.beginCover(coverId, { gameId, generation: 3 }),
    ).rejects.toThrow('own')
    await expect(
      catalog.updateListing(actor, { ...edit, generation: 2 }),
    ).rejects.toThrow('changed')
    expect(client.rpc).not.toHaveBeenCalled()
    expect(client.storage.from).not.toHaveBeenCalled()
  })
  it('binds cover upload receipts to the owner, game, generation, and upload id', async () => {
    const { catalog, client } = fixture()
    const uploaded = await catalog.beginCover(actor, { gameId, generation: 3 })
    await expect(
      catalog.updateListing(actor, {
        ...edit,
        coverId,
        coverToken: uploaded.coverToken,
      }),
    ).rejects.toThrow('expired')
    expect(client.rpc).not.toHaveBeenCalled()
  })
  it('validates and stores a replacement under a content-addressed key before committing', async () => {
    const { catalog, client, storage } = fixture()
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVR4nGNQckmDIwbiOABHgwzB3EcqzAAAAABJRU5ErkJggg==',
      'base64',
    )
    const expected = await normalizeCover(image)
    const key = createHash('sha256').update(expected).digest('hex')
    const coverToken = catalog.previewToken(
      `cover:${actor}:${gameId}:3:${coverId}`,
    )
    storage.download.mockResolvedValue({
      data: new Blob([new Uint8Array(image)]),
      error: null,
    })
    storage.upload.mockResolvedValue({ data: {}, error: null })
    await catalog.updateListing(actor, { ...edit, coverId, coverToken })
    expect(storage.upload).toHaveBeenCalledWith(
      `${gameId}/${key}.png`,
      expected,
      { contentType: 'image/png', upsert: true },
    )
    expect(client.rpc).toHaveBeenCalledWith(
      'update_game_listing',
      expect.objectContaining({
        replacement_cover: key,
        expected_generation: 3,
      }),
    )
  })
  it('leaves listing unchanged when cover validation or storage fails', async () => {
    const { catalog, client, storage } = fixture()
    const coverToken = catalog.previewToken(
      `cover:${actor}:${gameId}:3:${coverId}`,
    )
    storage.download.mockResolvedValue({
      data: new Blob(['not an image']),
      error: null,
    })
    await expect(
      catalog.updateListing(actor, { ...edit, coverId, coverToken }),
    ).rejects.toThrow('Choose a static')
    expect(client.rpc).not.toHaveBeenCalled()
    storage.download.mockResolvedValue({
      data: null,
      error: { message: 'Unavailable' },
    })
    await expect(
      catalog.updateListing(actor, { ...edit, coverId, coverToken }),
    ).rejects.toThrow('unavailable')
    expect(client.rpc).not.toHaveBeenCalled()
  })
})
