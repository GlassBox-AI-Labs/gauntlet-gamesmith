import { randomBytes } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { localClient } from '../server/supabase'
const hosted = process.argv[2] === '--hosted'
const [email, handle, ...name] = process.argv.slice(hosted ? 3 : 2)
const input = z
  .object({
    email: z.email(),
    handle: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(64),
    display_name: z.string().min(1).max(80),
  })
  .parse({ email, handle, display_name: name.join(' ') })
function hostedClient() {
  const url = process.env.SUPABASE_URL,
    key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || new URL(url).protocol !== 'https:')
    throw new Error(
      'Hosted provisioning requires an explicit HTTPS SUPABASE_URL and server key.',
    )
  console.log(`Provisioning publisher on ${new URL(url).hostname}`)
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
const password = randomBytes(24).toString('base64url'),
  db = hosted ? hostedClient() : localClient()
const created = await db.auth.admin.createUser({
  email: input.email,
  password,
  email_confirm: true,
})
if (created.error) throw new Error('Could not provision publisher identity.')
const saved = await db.from('publishers').insert({
  id: created.data.user.id,
  handle: input.handle,
  display_name: input.display_name,
})
if (saved.error) throw new Error('Could not provision publisher profile.')
const directory = path.join(os.homedir(), '.gauntlet-catalog')
await mkdir(directory, { recursive: true, mode: 0o700 })
const file = path.join(directory, `${handle}-${Date.now()}.json`)
await writeFile(file, JSON.stringify({ email, password }, null, 2), {
  mode: 0o600,
  flag: 'wx',
})
console.log(`Publisher provisioned. Credentials saved privately to ${file}.`)
