import 'server-only'
import { PublisherAuth } from '@gauntlet/data/api/publisher-auth'
import { createAdminClient } from './supabase-admin'
import { createAnonClient } from './supabase-anon'
import { captureServerError } from './capture'
export function publisherAuth() {
  return new PublisherAuth(
    createAdminClient(),
    createAnonClient(),
    captureServerError,
  )
}
export async function publisherForToken(token: string) {
  return publisherAuth().publisherForToken(token)
}
