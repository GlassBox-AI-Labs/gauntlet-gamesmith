import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { config } from './config'
export function createAdminClient() {
  const c = config()
  return createClient<Database>(c.url, c.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}
