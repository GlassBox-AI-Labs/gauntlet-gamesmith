import { route, readBody, requestPublisher } from '@/lib/http'
import { createConnections } from '@/lib/catalog'
export const POST = route('device.poll', async (request) =>
  createConnections().poll(await readBody(request)),
)
