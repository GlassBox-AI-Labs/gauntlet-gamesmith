import { listing, object, type Listing } from '@gauntlet/publishing'

/** Optional human-written details; defaults also work with the initial hosted API. */
export function publicationListing(value: unknown): Listing {
  const input = object(value)
  const description =
    input.description == null ||
    (typeof input.description === 'string' && !input.description.trim())
      ? 'Created with Gauntlet Gamesmith.'
      : input.description
  return listing({
    ...input,
    description,
    controls: input.controls ?? '',
    coverPath: null,
  })
}
