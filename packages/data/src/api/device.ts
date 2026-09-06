import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { CatalogError, checked, type Capture } from '../errors'
const sessionSchema = z.object({
  access_token: z.string().min(1).max(12000),
  refresh_token: z.string().min(1).max(12000),
})
export class DeviceConnections {
  constructor(
    private readonly client: SupabaseClient<Database>,
    private readonly key: string,
    private readonly capture: Capture,
  ) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid catalog secret')
  }
  async start(input: unknown) {
    const { challenge } = z
        .object({ challenge: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(input),
      code = randomBytes(8).toString('hex')
    checked(
      await this.client.rpc('start_desktop_connection', {
        connection_code: code,
        connection_challenge: challenge,
      }),
      this.capture,
      'device.start',
    )
    return code
  }
  async approve(actor: string, code: string, session: unknown) {
    z.string()
      .regex(/^[a-f0-9]{16}$/)
      .parse(code)
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', Buffer.from(this.key, 'hex'), iv)
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(sessionSchema.parse(session)), 'utf8'),
      cipher.final(),
    ])
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64',
    )
    const rows = checked(
      await this.client
        .from('desktop_connections')
        .update({ sealed_session: sealed, approved_by: actor })
        .eq('code', code)
        .is('sealed_session', null)
        .gt('expires_at', new Date().toISOString())
        .select('code'),
      this.capture,
      'device.approve',
    )
    if (!rows?.length)
      throw new CatalogError(
        'Connection expired or already approved. Start sign-in again.',
      )
  }
  async poll(input: unknown) {
    const { code, secret } = z
      .object({
        code: z.string().regex(/^[a-f0-9]{16}$/),
        secret: z.string().min(1).max(128),
      })
      .strict()
      .parse(input)
    const sealed = checked(
      await this.client.rpc('consume_desktop_connection', {
        connection_code: code,
        connection_challenge: createHash('sha256').update(secret).digest('hex'),
      }),
      this.capture,
      'device.consume',
    )
    if (!sealed) return { pending: true as const }
    const data = Buffer.from(sealed, 'base64'),
      decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(this.key, 'hex'),
        data.subarray(0, 12),
      )
    decipher.setAuthTag(data.subarray(12, 28))
    return sessionSchema.parse(
      JSON.parse(
        Buffer.concat([
          decipher.update(data.subarray(28)),
          decipher.final(),
        ]).toString('utf8'),
      ),
    )
  }
}
