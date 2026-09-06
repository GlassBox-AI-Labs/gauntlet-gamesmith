import type { PublisherCredentials } from '../shared/publishing'
import { object } from '@gauntlet/publishing'
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
