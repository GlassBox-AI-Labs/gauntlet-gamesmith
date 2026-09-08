import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { normalizeCover } from './cover'
describe('cover decoding', () => {
  it('normalizes actual raster pixels into a metadata-free PNG', async () => {
    const input = await sharp({
      create: { width: 16, height: 12, channels: 3, background: '#aabbcc' },
    })
      .jpeg()
      .withMetadata()
      .toBuffer()
    const result = await normalizeCover(input)
    const metadata = await sharp(result).metadata()
    expect(metadata).toMatchObject({ format: 'png', width: 16, height: 12 })
    expect(metadata.exif).toBeUndefined()
  })
  it('rejects a renamed SVG, truncated data, excessive bytes, and excessive dimensions', async () => {
    await expect(
      normalizeCover(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>',
        ),
      ),
    ).rejects.toThrow('Choose a static')
    await expect(normalizeCover(Buffer.from('not an image'))).rejects.toThrow(
      'Choose a static',
    )
    await expect(
      normalizeCover(Buffer.alloc(3 * 1024 * 1024 + 1)),
    ).rejects.toThrow('3 MiB')
    const wide = await sharp({
      create: { width: 4097, height: 1, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer()
    await expect(normalizeCover(wide)).rejects.toThrow('4096')
    await expect(normalizeCover(wide.subarray(0, 35))).rejects.toThrow(
      'Choose a static',
    )
  })
})
