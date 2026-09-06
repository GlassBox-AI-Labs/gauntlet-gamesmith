import { route, readBody } from '@/lib/http'
import { createConnections } from '@/lib/catalog'
import { requestOrigin } from '@/lib/config'
export const POST = route('device.start', async (request) => {
  const code = await createConnections().start(await readBody(request))
  return { code, url: `${requestOrigin(request)}/connect?code=${code}` }
})
