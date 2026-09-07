import { createClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { localEnvironment } from '../scripts/environment.mjs'
export function localClient() {
  const env = localEnvironment()
  return createClient<Database>(
    env.SUPABASE_URL!,
    env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}
