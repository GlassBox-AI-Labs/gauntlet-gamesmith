import {
  listing,
  object,
  type GameArtifact,
  type Listing,
} from '@gauntlet/publishing'

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

/** Only use an explicitly named shipping cover, never an arbitrary source image. */
export function publicationCover(artifact: GameArtifact): string | null {
  const paths = new Set(artifact.files.map((file) => file.path))
  for (const name of ['cover', 'thumbnail', 'preview', 'screenshot'])
    for (const dir of ['', 'assets/'])
      for (const extension of ['png', 'webp', 'jpg', 'jpeg', 'gif']) {
        const candidate = `${dir}${name}.${extension}`
        if (paths.has(candidate)) return candidate
      }
  return null
}
