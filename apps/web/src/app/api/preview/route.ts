import { route, readBody, requestPublisher } from '@/lib/http'
import { releasePreview } from '@/lib/catalog'
import { releaseIdSchema } from '@gauntlet/data/contracts'
export const POST = route('release.preview', async (request) => {
  const publisher = await requestPublisher(request, true),
    input = releaseIdSchema.parse(await readBody(request))
  return { url: await releasePreview(publisher.id, input.releaseId) }
})
