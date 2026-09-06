import { route, readBody, requestPublisher } from '@/lib/http'
import { createCatalog } from '@/lib/catalog'
import { releaseIdSchema } from '@gauntlet/data/contracts'
export const POST = route('release.complete', async (request) => {
  const publisher = await requestPublisher(request),
    input = releaseIdSchema.parse(await readBody(request))
  return createCatalog().complete(publisher.id, input.releaseId)
})
