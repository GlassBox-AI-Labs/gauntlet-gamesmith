import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export interface BackendConfig { url: string; key: string; anon: string }
export class BackendError extends Error { constructor(message: string, readonly status: number) { super(message) } }
export function localConfig(): BackendConfig {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_ANON_KEY) {
    return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, anon: process.env.SUPABASE_ANON_KEY }
  }
  // Supabase is our own local backend. Never inspect harness credential stores.
  const status = JSON.parse(execFileSync('supabase', ['status', '--output', 'json'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }))
  if (!status.API_URL || !status.SERVICE_ROLE_KEY || !status.ANON_KEY) throw new Error('Start local Supabase with pnpm catalog:db first.')
  return { url: status.API_URL, key: status.SERVICE_ROLE_KEY, anon: status.ANON_KEY }
}
export class Supabase {
  constructor(readonly config: BackendConfig) {}
  async request(route: string, options: RequestInit = {}, token = this.config.key): Promise<any> {
    const response = await fetch(`${this.config.url}${route}`, { ...options, headers: { apikey: this.config.anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(30000) })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      // Do not include request headers, tokens, or raw response bodies in errors.
      const message = typeof body.message === 'string' ? body.message : typeof body.msg === 'string' ? body.msg : 'Backend request failed.'
      throw new BackendError(message.slice(0, 240), response.status)
    }
    return response.status === 204 ? null : response.json()
  }
  table(name: string, query = '', options: RequestInit = {}): Promise<any> {
    return this.request(`/rest/v1/${name}${query}`, { ...options, headers: { Prefer: 'return=representation', ...options.headers } })
  }
  async publisher(token: string): Promise<{ id: string; handle: string; display_name: string }> {
    const user = await this.request('/auth/v1/user', {}, token)
    if (typeof user.id !== 'string') throw new Error('Sign in required.')
    const rows = await this.table('publishers', `?id=eq.${encodeURIComponent(user.id)}&enabled=eq.true`)
    if (!rows[0]) throw new Error('This account is not an approved publisher.')
    return rows[0]
  }
}
