import { signupSchema } from '@gauntlet/data/contracts'
import { route, readBody } from '@/lib/http'
import { publisherAuth } from '@/lib/auth-user'
export const POST = route('auth.desktop-signup', async (request) =>
  publisherAuth().signUp(signupSchema.parse(await readBody(request))),
)
