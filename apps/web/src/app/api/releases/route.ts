import { route, readBody, requestPublisher } from '@/lib/http'
import { createCatalog } from '@/lib/catalog'
export const POST = route('release.begin', async (request) => {
  const publisher = await requestPublisher(request, true)
  return createCatalog().begin(publisher.id, await readBody(request))
})
