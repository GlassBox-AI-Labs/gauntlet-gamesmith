import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import { publisherSchema } from '@gauntlet/data/contracts'
import { CatalogError, checked } from '@gauntlet/data/errors'
import { createClient } from './supabase-server'
import { createAdminClient } from './supabase-admin'
import { captureServerError } from './capture'
export async function publisherForToken(token: string) {
  const admin = createAdminClient(),
    { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) {
    if (error) {
      captureServerError(error, 'auth.token')
      if (
        (error.status ?? 0) >= 500 ||
        error.name === 'AuthRetryableFetchError'
      )
        throw new Error('Authentication is temporarily unavailable.')
    }
    throw new CatalogError('Sign in with a publisher account.', 'unauthorized')
  }
  return publisherForUser(data.user.id)
}
export async function publisherForUser(id: string) {
  const row = checked(
    await createAdminClient()
      .from('publishers')
      .select('id,handle,display_name')
      .eq('id', id)
      .eq('enabled', true)
      .maybeSingle(),
    captureServerError,
    'auth.publisher',
  )
  if (!row)
    throw new CatalogError(
      'This account is not an approved publisher.',
      'unauthorized',
    )
  return publisherSchema.parse(row)
}
export const getUser = cache(async () => {
  const client = await createClient(),
    { data, error } = await client.auth.getUser()
  if (error) {
    if (error.name === 'AuthSessionMissingError') return null
    captureServerError(error, 'auth.user')
    if ((error.status ?? 0) >= 500)
      throw new Error('Authentication is temporarily unavailable.')
    return null
  }
  return data.user
})
export const getPublisher = cache(async () => {
  const user = await getUser()
  return user ? publisherForUser(user.id) : null
})
export async function requirePublisher() {
  const publisher = await getPublisher()
  if (!publisher) redirect('/login')
  return publisher
}
