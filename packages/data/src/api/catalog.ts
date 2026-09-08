import {
  createHash,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { MAX_WIRE_BYTES, type GameArtifact } from '@gauntlet/publishing'
import { normalizeCover, validateArtifact } from '@gauntlet/publishing/node'
import {
  beginSchema,
  coverUploadSchema,
  listingUpdateSchema,
  gameSchema,
  promotionSchema,
  publicGamesSchema,
  releaseSchema,
  studioSchema,
  type Release,
} from '../contracts'
import { CatalogError, checked, type Capture } from '../errors'
type Client = SupabaseClient<Database>
export async function publicGames(client: Client, capture: Capture) {
  return publicGamesSchema.parse(
    checked(await client.rpc('catalog_games'), capture, 'catalog.list'),
  )
}
export async function studio(client: Client, capture: Capture, actor: string) {
  const data = checked(
    await client.rpc('publisher_studio', { actor }),
    capture,
    'catalog.studio',
  )
  if (!data)
    throw new CatalogError(
      'An approved publisher account is required.',
      'unauthorized',
    )
  return studioSchema.parse(data)
}
/** Trusted server adapter. Every write rechecks ownership before using admin privileges. */
export class Catalog {
  constructor(
    readonly client: Client,
    private readonly key: string,
    private readonly capture: Capture,
  ) {
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error('CATALOG_SECRET must be a 32-byte hex key.')
  }
  async game(id: string) {
    const data = checked(
      await this.client.from('games').select('*').eq('id', id).maybeSingle(),
      this.capture,
      'catalog.game',
    )
    if (!data) throw new CatalogError('Game not found.')
    return gameSchema.parse(data)
  }
  async owned(actor: string, id: string) {
    const game = await this.game(id)
    if (game.publisher_id !== actor)
      throw new CatalogError('You do not own this game.', 'unauthorized')
    return game
  }
  async release(id: string) {
    const data = checked(
      await this.client.from('releases').select('*').eq('id', id).maybeSingle(),
      this.capture,
      'catalog.release',
    )
    if (!data) throw new CatalogError('Release not found.')
    return releaseSchema.parse(data)
  }
  async begin(actor: string, input: unknown) {
    const data = beginSchema.parse(input)
    const release = releaseSchema.parse(
      checked(
        await this.client.rpc('begin_release', {
          actor,
          target_game: data.gameId,
          retry_key: data.requestKey,
          artifact_digest: data.digest,
          metadata: { ...data.listing },
          provenance: data.source,
        }),
        this.capture,
        'catalog.begin',
      ),
    )
    if (release.status === 'ready')
      return { releaseId: release.id, ready: true, uploadUrl: null }
    const upload = checked(
      await this.client.storage
        .from('game-artifacts')
        .createSignedUploadUrl(`pending/${release.id}.json`, { upsert: false }),
      this.capture,
      'catalog.upload-url',
    )
    return {
      releaseId: release.id,
      ready: false,
      uploadUrl: upload!.signedUrl,
    }
  }
  private async readArtifact(key: string) {
    const blob = checked(
      await this.client.storage.from('game-artifacts').download(key),
      this.capture,
      'catalog.artifact',
    )
    if (!blob || blob.size > MAX_WIRE_BYTES)
      throw new CatalogError('Artifact exceeds the shipping limit.')
    return validateArtifact(JSON.parse(await blob.text()))
  }
  async complete(actor: string, id: string) {
    const release = await this.release(id)
    await this.owned(actor, release.game_id)
    if (release.status === 'ready') return release
    try {
      const validated = await this.readArtifact(`pending/${release.id}.json`)
      if (
        validated.digest !== release.digest ||
        validated.artifact.sourceRevision !== release.source?.revision
      )
        throw new CatalogError(
          'Artifact does not match the selected saved round.',
        )
      if (
        release.listing.coverPath &&
        !validated.artifact.files.some(
          (f) => f.path === release.listing.coverPath,
        )
      )
        throw new CatalogError('Cover is missing from this build.')
      checked(
        await this.client.storage
          .from('game-artifacts')
          .upload(`${id}.json`, JSON.stringify(validated.artifact), {
            contentType: 'application/json',
            upsert: true,
          }),
        this.capture,
        'catalog.finalize-artifact',
      )
      return releaseSchema.parse(
        checked(
          await this.client
            .from('releases')
            .update({ status: 'ready', error: null })
            .eq('id', id)
            .select()
            .single(),
          this.capture,
          'catalog.complete',
        ),
      )
    } catch (error) {
      this.capture(error, 'catalog.complete-failed')
      checked(
        await this.client
          .from('releases')
          .update({
            status: 'failed',
            error:
              'Build validation failed. Retry publishing from the saved round.',
          })
          .eq('id', id)
          .neq('status', 'ready'),
        this.capture,
        'catalog.fail-release',
      )
      throw error
    }
  }
  async promote(actor: string, input: unknown) {
    const data = promotionSchema.parse(input)
    return gameSchema.parse(
      checked(
        await this.client.rpc('promote_game', {
          actor,
          target_game: data.gameId,
          // PostgreSQL accepts null for unpublish; generated RPC args omit nullability.
          target_release: data.releaseId!,
          expected_generation: data.generation,
        }),
        this.capture,
        'catalog.promote',
      ),
    )
  }
  async beginCover(actor: string, input: unknown) {
    const data = coverUploadSchema.parse(input)
    const game = await this.owned(actor, data.gameId)
    if (game.generation !== data.generation)
      throw new CatalogError('Game changed. Refresh before saving.', 'conflict')
    const coverId = randomUUID()
    const upload = checked(
      await this.client.storage
        .from('game-covers')
        .createSignedUploadUrl(`pending/${actor}/${game.id}/${coverId}.png`, {
          upsert: false,
        }),
      this.capture,
      'catalog.cover-upload',
    )
    return {
      coverId,
      uploadUrl: upload!.signedUrl,
      coverToken: this.previewToken(
        `cover:${actor}:${game.id}:${data.generation}:${coverId}`,
      ),
    }
  }
  async updateListing(actor: string, input: unknown) {
    const data = listingUpdateSchema.parse(input)
    const game = await this.owned(actor, data.gameId)
    if (game.generation !== data.generation)
      throw new CatalogError('Game changed. Refresh before saving.', 'conflict')
    let coverKey: string | undefined
    if (data.coverId) {
      if (
        !data.coverToken ||
        !this.validPreview(
          `cover:${actor}:${game.id}:${data.generation}:${data.coverId}`,
          data.coverToken,
        )
      )
        throw new CatalogError('Cover upload expired. Select the cover again.')
      const pending = `pending/${actor}/${game.id}/${data.coverId}.png`
      const uploaded = checked(
        await this.client.storage.from('game-covers').download(pending),
        this.capture,
        'catalog.cover-read',
      )
      if (!uploaded || uploaded.size > 3 * 1024 * 1024)
        throw new CatalogError('Cover exceeds 3 MiB.')
      const bytes = await normalizeCover(
        Buffer.from(await uploaded.arrayBuffer()),
      ).catch((error) => {
        throw new CatalogError(
          error instanceof Error ? error.message : 'Invalid cover image.',
        )
      })
      coverKey = createHash('sha256').update(bytes).digest('hex')
      // Content addressing makes retries safe and gives browsers a new URL after replacement.
      checked(
        await this.client.storage
          .from('game-covers')
          .upload(`${game.id}/${coverKey}.png`, bytes, {
            contentType: 'image/png',
            upsert: true,
          }),
        this.capture,
        'catalog.cover-store',
      )
    } else if (data.coverToken) throw new CatalogError('Invalid cover upload.')
    return gameSchema.parse(
      checked(
        await this.client.rpc('update_game_listing', {
          actor,
          target_game: game.id,
          expected_generation: data.generation,
          description: data.description,
          controls: data.controls,
          ...(coverKey ? { replacement_cover: coverKey } : {}),
        }),
        this.capture,
        'catalog.listing-update',
      ),
    )
  }
  async cover(actor: string, gameId: string): Promise<string | null> {
    const game = await this.owned(actor, gameId)
    if (game.cover_key)
      return `data:image/png;base64,${(await this.coverBytes(game.id, game.cover_key)).toString('base64')}`
    const owned = await studio(this.client, this.capture, actor)
    const release =
      owned.releases.find((r) => r.id === game.current_release_id) ??
      owned.releases.find((r) => r.game_id === game.id && r.status === 'ready')
    if (!release?.listing.coverPath) return null
    const artifact = await this.artifact(release)
    const file = artifact.files.find(
      (f) => f.path === release.listing.coverPath,
    )
    if (!file) return null
    const bytes = await normalizeCover(Buffer.from(file.data, 'base64'))
    return `data:image/png;base64,${bytes.toString('base64')}`
  }
  async coverBytes(gameId: string, key: string): Promise<Buffer> {
    const blob = checked(
      await this.client.storage
        .from('game-covers')
        .download(`${gameId}/${key}.png`),
      this.capture,
      'catalog.cover-download',
    )
    if (!blob || blob.size > 3 * 1024 * 1024)
      throw new CatalogError('Cover unavailable.')
    return Buffer.from(await blob.arrayBuffer())
  }
  async artifact(release: Release): Promise<GameArtifact> {
    const validated = await this.readArtifact(`${release.id}.json`)
    if (validated.digest !== release.digest)
      throw new CatalogError('Stored artifact checksum mismatch.')
    return validated.artifact
  }
  previewToken(id: string) {
    const expires = Math.floor(Date.now() / 1000) + 1800
    return `${expires}.${createHmac('sha256', this.key).update(`${id}:${expires}`).digest('hex')}`
  }
  validPreview(id: string, token: string) {
    const [expires, signature, ...rest] = token.split('.')
    if (
      rest.length ||
      !/^\d{10}$/.test(expires ?? '') ||
      !/^[a-f0-9]{64}$/.test(signature ?? '') ||
      Number(expires) < Date.now() / 1000
    )
      return false
    return timingSafeEqual(
      createHmac('sha256', this.key).update(`${id}:${expires}`).digest(),
      Buffer.from(signature, 'hex'),
    )
  }
}
