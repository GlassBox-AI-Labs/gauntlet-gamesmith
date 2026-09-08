import { route, readBody, requestPublisher } from '@/lib/http'
import { createCatalog } from '@/lib/catalog'
export const POST = route('covers/upload', async (request) => {
  const publisher = await requestPublisher(request)
  return createCatalog().beginCover(publisher.id, await readBody(request))
})
