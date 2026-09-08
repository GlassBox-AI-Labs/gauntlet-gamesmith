import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { PublisherAuth } from './publisher-auth'
import { resendSchema } from '../contracts'

const email = 'person@challenger.gauntletai.com'
const publisher = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'person',
  display_name: 'Person',
}
function fixture() {
  const signInWithOtp = vi.fn().mockResolvedValue({ error: null })
  const session = { access_token: 'test-access', refresh_token: 'test-refresh' }
  const verifyOtp = vi
    .fn()
    .mockResolvedValue({ data: { session }, error: null })
  const signOut = vi.fn().mockResolvedValue({ error: null })
  const getUser = vi
    .fn()
    .mockResolvedValue({ data: { user: { id: publisher.id } }, error: null })
  const rpc = vi.fn().mockResolvedValue({ data: publisher, error: null })
  const capture = vi.fn()
  const service = new PublisherAuth(
    { auth: { getUser }, rpc } as unknown as SupabaseClient<Database>,
    {
      auth: { signInWithOtp, verifyOtp, signOut },
    } as unknown as SupabaseClient<Database>,
    capture,
  )
  return { service, signInWithOtp, verifyOtp, signOut, rpc, capture, session }
}

describe('publisher email sign-in codes', () => {
  it('requests codes for existing accounts without creating users or exposing sessions', async () => {
    const f = fixture()
    expect(
      await f.service.sendSignInCode(resendSchema.parse({ email })),
    ).toEqual({ verificationRequired: true })
    expect(f.signInWithOtp).toHaveBeenCalledExactlyOnceWith({
      email,
      options: { shouldCreateUser: false },
    })
    expect(
      resendSchema.safeParse({ email: 'person@example.com' }).success,
    ).toBe(false)
    expect(
      resendSchema.safeParse({ email, shouldCreateUser: true }).success,
    ).toBe(false)
  })
  it('uses a safe error when a code cannot be sent', async () => {
    const f = fixture()
    f.signInWithOtp.mockResolvedValue({
      error: { status: 400, message: 'private account detail' },
    })
    await expect(f.service.sendSignInCode({ email })).rejects.toThrow(
      'Could not send a code.',
    )
    expect(f.capture).toHaveBeenCalledOnce()
  })
  it('verifies email codes and checks publisher access before releasing a session', async () => {
    const f = fixture()
    expect(await f.service.verify({ email, code: '123456' })).toEqual({
      ...f.session,
      publisher,
    })
    expect(f.verifyOtp).toHaveBeenCalledExactlyOnceWith({
      email,
      token: '123456',
      type: 'email',
    })
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('publisher_for_user', {
      actor: publisher.id,
    })
    expect(f.signOut).not.toHaveBeenCalled()
  })
  it('revokes a verified session when publisher enrollment is denied', async () => {
    const f = fixture()
    f.rpc.mockResolvedValue({ data: null, error: null })
    await expect(f.service.verify({ email, code: '123456' })).rejects.toThrow(
      'Publishing access is not available',
    )
    expect(f.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' })
  })
  it('rejects invalid codes without checking publisher access', async () => {
    const f = fixture()
    f.verifyOtp.mockResolvedValue({
      data: { session: null },
      error: { status: 403 },
    })
    await expect(f.service.verify({ email, code: '123456' })).rejects.toThrow(
      'invalid or expired',
    )
    expect(f.rpc).not.toHaveBeenCalled()
  })
})
