import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { cache } from 'react'
import type { Database } from '@gauntlet/db/types'
import { config, catalogOrigin } from './config'
export const createClient = cache(async () => {
  const store = await cookies(),
    c = config()
  return createServerClient<Database>(c.url, c.anon, {
    cookieOptions: {
      // Keep handoff cookies off every public/game-content URL, including local ports.
      path: '/connect',
      httpOnly: true,
      sameSite: 'lax',
      secure: catalogOrigin().startsWith('https:'),
    },
    cookies: {
      getAll: () => store.getAll(),
      setAll: (values) => {
        // Server Components only read; proxy.ts refreshes before render. Actions and handlers write.
        for (const value of values)
          store.set(value.name, value.value, value.options)
      },
    },
  })
})
