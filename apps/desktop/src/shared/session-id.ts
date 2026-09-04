import { redactLogText } from './redact-log'

export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Session/thread ids may identify private-home paths, so keep one strict grammar. */
export function normalizeSessionId(value: unknown): string | null {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) && redactLogText(value) === value ? value : null
}
