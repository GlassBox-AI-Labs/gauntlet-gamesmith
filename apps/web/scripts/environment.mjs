import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
)
export function localEnvironment() {
  if (
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.SUPABASE_ANON_KEY &&
    process.env.CATALOG_SECRET
  )
    return { ...process.env }
  const status = JSON.parse(
    execFileSync('supabase', ['status', '--output', 'json'], {
      cwd: path.join(repoRoot, 'packages/db'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  )
  const privateDir = path.join(repoRoot, '.catalog')
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 })
  const secretFile = path.join(privateDir, 'secret')
  if (!fs.existsSync(secretFile))
    fs.writeFileSync(secretFile, randomBytes(32).toString('hex'), {
      mode: 0o600,
      flag: 'wx',
    })
  return {
    ...process.env,
    SUPABASE_URL: status.API_URL,
    SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    CATALOG_SECRET: fs.readFileSync(secretFile, 'utf8').trim(),
  }
}
