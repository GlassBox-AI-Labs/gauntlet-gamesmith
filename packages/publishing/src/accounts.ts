/** Exact enrollment domain; possession is verified by Supabase Auth on the server. */
export const PUBLISHER_EMAIL_DOMAIN = 'challenger.gauntletai.com'
/** Match the hosted Supabase email OTP length and the checked-in auth.email config. */
export const PUBLISHER_OTP_LENGTH = 8
const publisherOtpPattern = new RegExp(`^\\d{${PUBLISHER_OTP_LENGTH}}$`)
export function isPublisherOtp(code: unknown): code is string {
  return typeof code === 'string' && publisherOtpPattern.test(code)
}
export function isPublisherEmail(email: string): boolean {
  return /^[^@\s]+@challenger\.gauntletai\.com$/i.test(email.trim())
}
