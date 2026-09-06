import { route, readBody, requestPublisher } from '@/lib/http'
import { createCatalog } from '@/lib/catalog'
import { revalidatePath } from 'next/cache'
export const POST = route('release.promote', async (request) => {
  const publisher = await requestPublisher(request),
    game = await createCatalog().promote(publisher.id, await readBody(request))
  revalidatePath('/')
  revalidatePath(`/games/${game.slug}`)
  return game
})
