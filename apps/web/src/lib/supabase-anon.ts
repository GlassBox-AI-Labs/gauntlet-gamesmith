import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { publicConfig } from './config'
export function createAnonClient() {
  const c = publicConfig()
  return createClient<Database>(c.url, c.anon, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}
