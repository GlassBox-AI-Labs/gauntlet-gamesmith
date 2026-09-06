import 'server-only'
import { Catalog } from '@gauntlet/data/api/catalog'
import { DeviceConnections } from '@gauntlet/data/api/device'
import { createAdminClient } from './supabase-admin'
import { captureServerError } from './capture'
import { config, gameOrigin } from './config'
export const createCatalog = () =>
  new Catalog(createAdminClient(), config().secret, captureServerError)
export const createConnections = () =>
  new DeviceConnections(
    createAdminClient(),
    config().secret,
    captureServerError,
  )
export async function releasePreview(actor: string, id: string) {
  const catalog = createCatalog(),
    release = await catalog.release(id)
  await catalog.owned(actor, release.game_id)
  if (release.status !== 'ready') throw new Error('Release is not ready.')
  return `${await gameOrigin()}/preview/${release.id}/${catalog.previewToken(release.id)}/index.html`
}
