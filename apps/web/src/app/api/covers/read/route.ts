import { route, readBody, requestPublisher } from '@/lib/http'
import { createCatalog } from '@/lib/catalog'
import { gameIdSchema } from '@gauntlet/data/contracts'
export const POST = route('covers/read', async (request) => {
  const publisher = await requestPublisher(request)
  const { gameId } = gameIdSchema.parse(await readBody(request))
  return { dataUrl: await createCatalog().cover(publisher.id, gameId) }
})
