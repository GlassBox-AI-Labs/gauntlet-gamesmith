import { resendSchema } from '@gauntlet/data/contracts'
import { route, readBody } from '@/lib/http'
import { publisherAuth } from '@/lib/auth-user'

export const POST = route('auth.desktop-sign-in-code', async (request) =>
  publisherAuth().sendSignInCode(resendSchema.parse(await readBody(request))),
)
