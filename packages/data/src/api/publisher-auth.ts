import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { publisherSchema } from '../contracts'
import { CatalogError, checked, type Capture } from '../errors'

/** Verify identity and enrollment before releasing any publisher session. */
export class PublisherAuth {
  constructor(
    private readonly admin: SupabaseClient<Database>,
    private readonly anon: SupabaseClient<Database>,
    private readonly capture: Capture,
  ) {}
  async publisherForUser(id: string) {
    const row = checked(
      await this.admin.rpc('publisher_for_user', { actor: id }),
      this.capture,
      'auth.publisher',
    )
    if (!row)
      throw new CatalogError(
        'This account is not an approved publisher. Verify your Challenger email to publish.',
        'unauthorized',
      )
    return publisherSchema.parse(row)
  }
  async publisherForToken(token: string) {
    const { data, error } = await this.admin.auth.getUser(token)
    if (error || !data.user) {
      this.authError(error, 'auth.token', 'Sign in with a publisher account.')
    }
    return this.publisherForUser(data.user!.id)
  }
  private authError(
    error: { name?: string; status?: number } | null,
    context: string,
    message: string,
  ): never {
    if (error) this.capture(error, context)
    if (
      (error?.status ?? 0) >= 500 ||
      error?.name === 'AuthRetryableFetchError'
    )
      throw new Error('Authentication is temporarily unavailable.')
    throw new CatalogError(message, 'unauthorized')
  }
  private async authorizedSession(session: {
    access_token: string
    refresh_token: string
  }) {
    try {
      const publisher = await this.publisherForToken(session.access_token)
      return {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        publisher,
      }
    } catch (error) {
      const revoked = await this.anon.auth.signOut({ scope: 'local' })
      if (revoked.error)
        this.capture(revoked.error, 'auth.denied-session-revoke')
      throw error
    }
  }
  async signIn(input: { email: string; password: string }) {
    const { data, error } = await this.anon.auth.signInWithPassword(input)
    if (error || !data.session)
      this.authError(
        error,
        'auth.password-grant',
        'Could not sign in. Check your email and password, and verify your email if you just created an account.',
      )
    return this.authorizedSession(data.session!)
  }
  async signUp(input: {
    email: string
    password: string
    displayName: string
  }) {
    const { data, error } = await this.anon.auth.signUp({
      email: input.email,
      password: input.password,
      options: { data: { publisher_name: input.displayName } },
    })
    if (error)
      this.authError(
        error,
        'auth.signup',
        'Could not create the account. Check your details or wait before trying again.',
      )
    // Confirmation must be enabled in Supabase. Never return an automatic signup session.
    if (data.session) {
      const revoked = await this.anon.auth.signOut({ scope: 'local' })
      if (revoked.error) this.capture(revoked.error, 'auth.signup-revoke')
      throw new Error(
        'Email confirmation must be enabled for publisher signup.',
      )
    }
    return { verificationRequired: true as const }
  }
  async verify(input: { email: string; code: string }) {
    const { data, error } = await this.anon.auth.verifyOtp({
      email: input.email,
      token: input.code,
      type: 'email',
    })
    if (error || !data.session)
      this.authError(
        error,
        'auth.verify-email',
        'The verification code is invalid or expired. Request a new code and try again.',
      )
    return this.authorizedSession(data.session!)
  }
  async resend(input: { email: string }) {
    const { error } = await this.anon.auth.resend({
      type: 'signup',
      email: input.email,
    })
    if (error)
      this.authError(
        error,
        'auth.resend',
        'Could not send a code. Wait a minute before trying again.',
      )
    return { verificationRequired: true as const }
  }
}
