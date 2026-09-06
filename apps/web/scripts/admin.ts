import { randomBytes } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { boundedText } from '@gauntlet/publishing'
import { localConfig, Supabase } from '../server/supabase'
const [email, handle, ...nameParts] = process.argv.slice(2)
if (!email || !handle || !nameParts.length || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle)) throw new Error('Usage: pnpm catalog:admin EMAIL HANDLE DISPLAY NAME')
const password = randomBytes(24).toString('base64url'), db = new Supabase(localConfig())
const user = await db.request('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: boundedText(email, 'email', 254), password, email_confirm: true }) })
await db.table('publishers', '', { method: 'POST', body: JSON.stringify({ id: user.id, handle, display_name: boundedText(nameParts.join(' '), 'display name', 80) }) })
const directory = path.join(os.homedir(), '.gauntlet-catalog')
await mkdir(directory, { recursive: true, mode: 0o700 })
const file = path.join(directory, `${handle}-${Date.now()}.json`)
await writeFile(file, JSON.stringify({ email, password }, null, 2), { mode: 0o600, flag: 'wx' })
console.log(`Publisher provisioned. Local credentials saved privately to ${file}. Open this file locally to sign in; do not commit or share it.`)
