import { route, readBody, requestPublisher } from '@/lib/http'
import { createCatalog } from '@/lib/catalog'
import { revalidatePath } from 'next/cache'
export const POST = route('listing', async (request) => {
  const publisher = await requestPublisher(request)
  const game = await createCatalog().updateListing(
    publisher.id,
    await readBody(request),
  )
  revalidatePath('/')
  revalidatePath(`/games/${game.slug}`)
  revalidatePath(`/publishers/${publisher.handle}`)
  return game
})
