import type { PublisherCredentials } from '../shared/publishing'
import {
  boundedText,
  isPublisherEmail,
  object,
  PUBLISHER_EMAIL_DOMAIN,
} from '@gauntlet/publishing'
/** Validate IPC without normalizing the password or including credentials in errors. */
export function publisherCredentials(value: unknown): PublisherCredentials {
  const input = object(value)
  if (
    typeof input.email !== 'string' ||
    input.email.trim().length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) ||
    typeof input.password !== 'string' ||
    input.password.length < 1 ||
    input.password.length > 200
  ) {
    throw new Error('Enter a valid publisher email and password.')
  }
  return { email: input.email.trim(), password: input.password }
}
export function enrollmentEmail(value: unknown): { email: string } {
  const { email } = object(value)
  if (
    typeof email !== 'string' ||
    email.trim().length > 254 ||
    !isPublisherEmail(email)
  )
    throw new Error(`Use your @${PUBLISHER_EMAIL_DOMAIN} email address.`)
  return { email: email.trim().toLowerCase() }
}
export function publisherSignup(value: unknown) {
  const input = object(value)
  const credentials = publisherCredentials(input)
  if (credentials.password.length < 10)
    throw new Error('Use a password with at least 10 characters.')
  return {
    ...credentials,
    ...enrollmentEmail(input),
    displayName: boundedText(input.displayName, 'publisher name', 80),
  }
}
export function publisherVerification(value: unknown) {
  const input = object(value)
  if (typeof input.code !== 'string' || !/^\d{6,10}$/.test(input.code))
    throw new Error('Enter the verification code from your email.')
  return { ...enrollmentEmail(input), code: input.code }
}
