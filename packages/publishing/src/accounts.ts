/** Exact enrollment domain; possession is verified by Supabase Auth on the server. */
export const PUBLISHER_EMAIL_DOMAIN = 'challenger.gauntletai.com'
export function isPublisherEmail(email: string): boolean {
  return /^[^@\s]+@challenger\.gauntletai\.com$/i.test(email.trim())
}
