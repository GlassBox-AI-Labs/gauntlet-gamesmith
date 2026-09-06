import { randomBytes } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { localClient } from '../server/supabase'
const [email, handle, ...name] = process.argv.slice(2)
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
const password = randomBytes(24).toString('base64url'),
  db = localClient()
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
