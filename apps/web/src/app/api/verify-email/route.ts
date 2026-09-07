import { verificationSchema } from '@gauntlet/data/contracts'
import { route, readBody } from '@/lib/http'
import { publisherAuth } from '@/lib/auth-user'
export const POST = route('auth.desktop-verify-email', async (request) =>
  publisherAuth().verify(verificationSchema.parse(await readBody(request))),
)
