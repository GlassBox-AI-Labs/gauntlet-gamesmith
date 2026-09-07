import { createHash } from 'node:crypto'
import { z } from 'zod'
import { joinInput, MANIFEST_FILE, multiplayerManifest } from '@gauntlet/multiplayer'
import { MultiplayerServer, roomScope } from '@gauntlet/multiplayer/server'
import type { Catalog } from './catalog'
const requestSchema = z.discriminatedUnion('action', [
  joinInput.extend({ action: z.literal('join') }),
  z.object({ action: z.enum(['status', 'start', 'leave']), ticket: z.string().max(3000) }).strict(),
])
/** Guest room access is bound to an actual published release or a valid private preview. */
export class MultiplayerCatalog {
  constructor(private catalog: Catalog, private server: MultiplayerServer, private secret: string) {}
  async request(value: unknown, clientAddress: string) {
    const input = requestSchema.parse(value)
    if (input.action !== 'join') {
      const claims = this.server.verify(input.ticket)
      if (!await this.server.store.limit(`player:${claims.playerId}`, 150, 60)) throw new Error('Too many room requests. Try again shortly.')
      if (input.action === 'leave') { await this.server.store.leave(claims); return { serverTime: Date.now() } }
      return this.server.room(input.ticket, input.action === 'start')
    }
    const clientHash = createHash('sha256').update(clientAddress).digest('hex').slice(0, 32)
    if (!await this.server.store.limit(`join:${clientHash}`, 20, 60)) throw new Error('Too many room requests. Try again shortly.')
    const release = await this.catalog.release(input.releaseId)
    if (release.game_id !== input.gameId || release.status !== 'ready') throw new Error('This game is unavailable.')
    const preview = !!input.previewToken
    if (preview) {
      if (!this.catalog.validPreview(input.releaseId, input.previewToken!)) throw new Error('This preview expired.')
    } else if ((await this.catalog.game(input.gameId)).current_release_id !== release.id) throw new Error('This game is unavailable.')
    const artifact = await this.catalog.artifact(release)
    const file = artifact.files.find(f => f.path === MANIFEST_FILE)
    if (!file || file.data.length > 4096) throw new Error('This game does not support multiplayer.')
    const manifest = multiplayerManifest.parse(JSON.parse(Buffer.from(file.data, 'base64').toString('utf8')))
    return this.server.join({ ...input, manifest, scope: roomScope(this.secret, input.gameId, input.releaseId, preview) })
  }
}
