import { resendSchema } from '@gauntlet/data/contracts'
import { route, readBody } from '@/lib/http'
import { publisherAuth } from '@/lib/auth-user'
export const POST = route('auth.desktop-resend-verification', async (request) =>
  publisherAuth().resend(resendSchema.parse(await readBody(request))),
)
