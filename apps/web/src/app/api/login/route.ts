import { z } from 'zod'
import { route, readBody } from '@/lib/http'
import { createAnonClient } from '@/lib/supabase-anon'
import { publisherForUser } from '@/lib/auth-user'
import { captureServerError } from '@/lib/capture'
import { CatalogError } from '@gauntlet/data/errors'
/** Desktop protocol only: no cookies, browser forms, or persistent password storage. */
export const POST = route('auth.desktop-login', async (request) => {
  const input = z
    .object({ email: z.email().max(254), password: z.string().min(1).max(200) })
    .strict()
    .parse(await readBody(request))
  const client = createAnonClient()
  const { data, error } = await client.auth.signInWithPassword(input)
  if (error || !data.session || !data.user) {
    if (error) captureServerError(error, 'auth.password-grant')
    if (
      error &&
      ((error.status ?? 0) >= 500 || error.name === 'AuthRetryableFetchError')
    )
      throw new Error('Authentication unavailable')
    throw new CatalogError(
      'Could not sign in. Check your email and password.',
      'unauthorized',
    )
  }
  try {
    const publisher = await publisherForUser(data.user.id)
    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      publisher,
    }
  } catch (error) {
    const revoked = await client.auth.signOut({ scope: 'local' })
    if (revoked.error)
      captureServerError(revoked.error, 'auth.denied-session-revoke')
    throw error
  }
})
