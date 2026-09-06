import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { Database } from '@gauntlet/db/types'
import { captureServerError } from './lib/capture'
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })
  const url = process.env.SUPABASE_URL!,
    anon = process.env.SUPABASE_ANON_KEY!
  const client = createServerClient<Database>(url, anon, {
    cookieOptions: {
      // Keep handoff cookies off every public/game-content URL, including local ports.
      path: '/connect',
      httpOnly: true,
      sameSite: 'lax',
      secure: request.nextUrl.protocol === 'https:',
    },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (values) => {
        for (const value of values) request.cookies.set(value.name, value.value)
        response = NextResponse.next({ request })
        for (const value of values)
          response.cookies.set(value.name, value.value, value.options)
      },
    },
  })
  const { error } = await client.auth.getUser()
  if (error && error.name !== 'AuthSessionMissingError')
    captureServerError(error, 'auth.refresh')
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
export const config = { matcher: ['/connect', '/login'] }
