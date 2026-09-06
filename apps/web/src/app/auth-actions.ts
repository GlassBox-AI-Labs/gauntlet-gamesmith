'use server'
import { z } from 'zod'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import type { MutationResult } from '@gauntlet/data/contracts'
import { CatalogError } from '@gauntlet/data/errors'
import { createClient } from '@/lib/supabase-server'
import { getPublisher, publisherForUser } from '@/lib/auth-user'
import { createConnections } from '@/lib/catalog'
import { captureServerError } from '@/lib/capture'
export async function signIn(
  _: MutationResult<null> | null,
  form: FormData,
): Promise<MutationResult<null>> {
  const parsed = z
    .object({ email: z.email(), password: z.string().min(1).max(200) })
    .safeParse({ email: form.get('email'), password: form.get('password') })
  if (!parsed.success)
    return {
      ok: false,
      code: 'invalid_request',
      message: 'Enter your publisher email and password.',
    }
  const client = await createClient(),
    { data, error } = await client.auth.signInWithPassword(parsed.data)
  if (error || !data.user) {
    captureServerError(error, 'auth.sign-in')
    return {
      ok: false,
      code: 'unauthorized',
      message: 'Could not sign in. Check your email and password.',
    }
  }
  try {
    await publisherForUser(data.user.id)
  } catch (error) {
    captureServerError(error, 'auth.publisher-sign-in')
    await client.auth.signOut()
    if (error instanceof CatalogError)
      return { ok: false, code: error.code, message: error.message }
    throw error
  }
  const code = form.get('code')
  redirect(
    typeof code === 'string' && /^[a-f0-9]{16}$/.test(code)
      ? `/connect?code=${code}`
      : '/',
  )
}
export async function signOut() {
  const client = await createClient()
  const { error } = await client.auth.signOut()
  if (error) {
    captureServerError(error, 'auth.sign-out')
    throw new Error('Could not sign out. Try again.')
  }
  redirect('/login')
}
export async function approveConnection(
  _: MutationResult<null> | null,
  form: FormData,
): Promise<MutationResult<null>> {
  const publisher = await getPublisher()
  if (!publisher)
    return {
      ok: false,
      code: 'unauthorized',
      message: 'Sign in again to connect the desktop.',
    }
  const code = z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .safeParse(form.get('code'))
  if (!code.success)
    return {
      ok: false,
      code: 'invalid_request',
      message: 'Invalid desktop connection.',
    }
  const client = await createClient(),
    { data, error } = await client.auth.refreshSession()
  if (error || !data.session) {
    captureServerError(error, 'auth.transfer-refresh')
    return {
      ok: false,
      code: 'unauthorized',
      message: 'Sign in again to connect the desktop.',
    }
  }
  try {
    await createConnections().approve(publisher.id, code.data, {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    })
  } catch (error) {
    captureServerError(error, 'auth.transfer')
    if (error instanceof CatalogError)
      return { ok: false, code: error.code, message: error.message }
    throw error
  }
  // Clear this browser's cookies without revoking the session transferred to desktop.
  const store = await cookies()
  for (const cookie of store.getAll())
    if (cookie.name.startsWith('sb-')) {
      store.set(cookie.name, '', {
        path: '/connect',
        maxAge: 0,
        httpOnly: true,
        sameSite: 'lax',
      })
      store.delete(cookie.name)
    }
  redirect('/connect/complete')
}
