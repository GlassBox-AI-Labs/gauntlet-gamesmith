import sharp from 'sharp'
/** Decode real raster content under a pixel limit, then strip metadata and normalize to PNG. */
export async function normalizeCover(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > 3 * 1024 * 1024)
    throw new Error('Cover must be at most 3 MiB.')
  try {
    const image = sharp(bytes, {
      limitInputPixels: 4096 * 4096,
      failOn: 'warning',
    })
    const meta = await image.metadata()
    if (
      !['png', 'jpeg', 'webp', 'gif'].includes(meta.format ?? '') ||
      !meta.width ||
      !meta.height ||
      meta.width > 4096 ||
      meta.height > 4096 ||
      (meta.pages ?? 1) > 1
    )
      throw new Error('Unsupported image')
    const normalized = await image.rotate().png().toBuffer()
    if (normalized.length > 3 * 1024 * 1024) throw new Error('Image too large')
    return normalized
  } catch {
    throw new Error(
      'Choose a static PNG, JPEG, WebP, or GIF up to 4096 × 4096 pixels and 3 MiB.',
    )
  }
}
