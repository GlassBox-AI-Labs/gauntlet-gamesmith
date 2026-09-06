import { randomUUID, randomBytes, timingSafeEqual, createHmac } from 'node:crypto'
import { listing, uuid, type GameArtifact, type Listing } from '@gauntlet/publishing'
import { validateArtifact } from '@gauntlet/publishing/node'
import { BackendError, Supabase } from './supabase'
export interface Game { id: string; publisher_id: string; slug: string; current_release_id: string | null; generation: number }
export interface Release { id: string; game_id: string; digest: string; listing: Listing; status: string; base_generation: number; error: string | null; created_at: string }

/** Owns upload/recovery and promotion. Callers cannot set readiness or impersonate an owner. */
export class Catalog {
  private readonly previewKey = randomBytes(32)
  private readonly artifacts = new Map<string, { artifact: GameArtifact; bytes: number }>()
  private readonly fetching = new Map<string, Promise<GameArtifact>>()
  constructor(readonly db: Supabase) {}
  async recoverUploads(): Promise<number> {
    let recovered = 0
    for (;;) {
      const pending: Release[] = await this.db.table('releases', '?status=eq.uploading&limit=100')
      if (!pending.length) return recovered
      for (const release of pending) {
        let patch: { status: string; error: string | null }
        try {
          await this.artifact(release)
          patch = { status: 'ready', error: null }
        } catch (error) {
          if (error instanceof BackendError && error.status !== 404 && !(error.status === 400 && /not found|does not exist/i.test(error.message))) throw error
          if (!(error instanceof BackendError) && !(error instanceof Error && /checksum|artifact|manifest|asset/i.test(error.message))) throw error
          patch = { status: 'failed', error: 'Upload was interrupted or invalid. Retry the original artifact.' }
        }
        await this.db.table('releases', `?id=eq.${release.id}&status=eq.uploading`, { method: 'PATCH', body: JSON.stringify(patch) })
        await this.db.table('publication_events', '', { method: 'POST', body: JSON.stringify({ game_id: release.game_id, release_id: release.id, kind: `recovered-${patch.status}` }) })
        recovered++
      }
    }
  }
  async game(id: string): Promise<Game> {
    const rows = await this.db.table('games', `?id=eq.${uuid(id)}`)
    if (!rows[0]) throw new Error('Game not found.')
    return rows[0]
  }
  async owned(actor: string, id: string): Promise<Game> {
    const game = await this.game(id)
    if (game.publisher_id !== actor) throw new Error('You do not own this game.')
    return game
  }
  async release(id: string): Promise<Release> {
    const rows = await this.db.table('releases', `?id=eq.${uuid(id)}`)
    if (!rows[0]) throw new Error('Release not found.')
    return rows[0]
  }
  async upload(actor: string, input: { gameId: unknown; requestKey: unknown; listing: unknown; artifact: unknown }): Promise<Release> {
    const metadata = listing(input.listing), key = uuid(input.requestKey)
    const validated = validateArtifact(input.artifact)
    if (metadata.coverPath && !validated.artifact.files.some(f => f.path === metadata.coverPath)) throw new Error('Cover is missing from this build.')
    const gameId = uuid(input.gameId)
    let game: Game
    const existing = await this.db.table('games', `?id=eq.${gameId}`)
    if (existing[0]) { game = await this.owned(actor, gameId); if (metadata.slug !== game.slug) throw new Error('An existing game keeps its URL slug.') }
    else {
      try { game = (await this.db.table('games', '', { method: 'POST', body: JSON.stringify({ id: gameId, publisher_id: actor, slug: metadata.slug }) }))[0] }
      catch { game = await this.owned(actor, gameId) }
    }
    const old = await this.db.table('releases', `?game_id=eq.${game.id}&request_key=eq.${key}`)
    let release: Release = old[0]
    if (!release) {
      try {
        release = (await this.db.table('releases', '', { method: 'POST', body: JSON.stringify({ id: randomUUID(), game_id: game.id, request_key: key, digest: validated.digest, listing: metadata, base_generation: game.generation }) }))[0]
      } catch {
        release = (await this.db.table('releases', `?game_id=eq.${game.id}&request_key=eq.${key}`))[0]
        if (!release) throw new Error('Could not create release; retry the upload.')
      }
    }
    if (release.digest !== validated.digest || JSON.stringify(listing(release.listing)) !== JSON.stringify(metadata)) throw new Error('Retry key belongs to a different artifact or listing.')
    if (release.status === 'ready') return release
    try {
      await this.db.request(`/storage/v1/object/game-artifacts/${release.id}.json`, { method: 'POST', headers: { 'x-upsert': 'true' }, body: JSON.stringify(validated.artifact) })
      // Concurrent identical retries are safe: they all upload the same validated digest.
      const rows = await this.db.table('releases', `?id=eq.${release.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'ready', error: null }) })
      return rows[0]
    } catch (error) {
      await this.db.table('releases', `?id=eq.${release.id}&status=neq.ready`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', error: 'Upload interrupted. Retry this artifact.' }) }).catch(() => {})
      throw error
    }
  }
  async promote(actor: string, gameId: string, releaseId: string | null, generation: unknown): Promise<Game> {
    if (!Number.isSafeInteger(generation) || (generation as number) < 0) throw new Error('Invalid game version.')
    return this.db.request('/rest/v1/rpc/promote_game', { method: 'POST', body: JSON.stringify({ actor: uuid(actor), target_game: uuid(gameId), target_release: releaseId === null ? null : uuid(releaseId), expected_generation: generation }) })
  }
  async publicGames(): Promise<any[]> {
    const games: Game[] = await this.db.table('games', '?current_release_id=not.is.null&order=created_at.desc&limit=100')
    return Promise.all(games.map(async game => {
      const release = await this.release(game.current_release_id!)
      const publisher = (await this.db.table('publishers', `?id=eq.${game.publisher_id}&select=id,handle,display_name`))[0]
      return { ...game, listing: release.listing, publisher }
    }))
  }
  async artifact(release: Release): Promise<GameArtifact> {
    const cached = this.artifacts.get(release.id)
    if (cached) return cached.artifact
    const pending = this.fetching.get(release.id)
    if (pending) return pending
    if (this.fetching.size >= 4) throw new Error('Game host is busy. Please retry shortly.')
    const loading = (async () => {
      const raw = await this.db.request(`/storage/v1/object/game-artifacts/${release.id}.json`)
      const result = validateArtifact(raw)
      if (result.digest !== release.digest) throw new Error('Stored artifact checksum mismatch.')
      let held = [...this.artifacts.values()].reduce((sum, item) => sum + item.bytes, 0)
      while (held + result.bytes > 48 * 1024 * 1024 && this.artifacts.size) {
        const oldest = this.artifacts.keys().next().value!
        held -= this.artifacts.get(oldest)!.bytes; this.artifacts.delete(oldest)
      }
      this.artifacts.set(release.id, result)
      return result.artifact
    })()
    this.fetching.set(release.id, loading)
    try { return await loading } finally { this.fetching.delete(release.id) }
  }
  previewToken(release: string): string {
    const expires = Math.floor(Date.now() / 1000) + 1800
    const signature = createHmac('sha256', this.previewKey).update(`${release}:${expires}`).digest('hex')
    return `${expires}.${signature}`
  }
  validPreview(release: string, token: string): boolean {
    const [expires, signature] = token.split('.')
    if (!/^\d{10}$/.test(expires ?? '') || !/^[a-f0-9]{64}$/.test(signature ?? '') || Number(expires) < Date.now() / 1000) return false
    const expected = createHmac('sha256', this.previewKey).update(`${release}:${expires}`).digest()
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'))
  }
}
