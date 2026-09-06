import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { MAX_WIRE_BYTES, type GameArtifact } from '@gauntlet/publishing'
import { validateArtifact } from '@gauntlet/publishing/node'
import {
  beginSchema,
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
