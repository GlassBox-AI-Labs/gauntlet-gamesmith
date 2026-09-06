import { route, readBody, requestPublisher } from '@/lib/http'
import { z } from 'zod'
import { createAnonClient } from '@/lib/supabase-anon'
import { publisherForToken } from '@/lib/auth-user'
import { CatalogError } from '@gauntlet/data/errors'
export const POST = route('auth.desktop-refresh', async (request) => {
  const input = z
    .object({ refreshToken: z.string().min(1).max(12000) })
    .strict()
    .parse(await readBody(request))
  const { data, error } = await createAnonClient().auth.refreshSession({
    refresh_token: input.refreshToken,
  })
  if (error || !data.session)
    throw new CatalogError('Sign in again.', 'unauthorized')
  await publisherForToken(data.session.access_token)
  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  }
})
