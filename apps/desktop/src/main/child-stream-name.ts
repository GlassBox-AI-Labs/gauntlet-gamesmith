import type { HarnessKind } from '../shared/harness'

const CHILD_STREAM_PATTERN = /^([a-z0-9-]{1,64})\.(claude|codex)\.jsonl$/
const ARCHIVED_CHILD_STREAM_PATTERN = /^(.+\.(?:claude|codex)\.jsonl)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.archived$/
export const MAX_CHILD_STREAMS = 256
export const MAX_CHILD_DIRECTORY_ENTRIES = 1_024
export const MAX_CHILD_PROJECTION_READ_BYTES = 1024 * 1024
export const MAX_CHILD_STREAM_BYTES = 64 * 1024 * 1024
export const MAX_CHILD_ACCOUNTING_FILE_BYTES = 8 * 1024 * 1024
export const MAX_CHILD_ACCOUNTING_TOTAL_BYTES = 32 * 1024 * 1024

export interface ChildStreamName {
  slug: string
  harness: HarnessKind
}

/** Parse the only filename grammar delegation is allowed to create. */
export function parseChildStreamName(file: string): ChildStreamName | null {
  const match = CHILD_STREAM_PATTERN.exec(file)
  return match ? { slug: match[1], harness: match[2] as HarnessKind } : null
}

/** Parse the no-clobber unique name used after a child stream is archived. */
export function parseArchivedChildStreamName(file: string): ChildStreamName | null {
  const match = ARCHIVED_CHILD_STREAM_PATTERN.exec(file)
  return match ? parseChildStreamName(match[1]) : null
}

/** Validate a slug before interpolating it into a delegated shell command. */
export function assertChildSlug(slug: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw new Error('Delegated agent slug must match [a-z0-9-]+ and be at most 64 characters.')
  return slug
}
