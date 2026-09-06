import { credentialsSchema } from '@gauntlet/data/contracts'
import { route, readBody } from '@/lib/http'
import { publisherAuth } from '@/lib/auth-user'
export const POST = route('auth.desktop-login', async (request) =>
  publisherAuth().signIn(credentialsSchema.parse(await readBody(request))),
)
