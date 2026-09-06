import { describe, expect, it } from 'vitest'
import type { GameArtifact } from '@gauntlet/publishing'
import { publicationCover, publicationListing } from './publication-listing'
describe('optional publishing details', () => {
  it('allows a title and URL alone and ignores caller-selected packaging paths', () => {
    const result = publicationListing({
      title: 'Maze',
      slug: 'maze',
      description: '  ',
      outputDir: '/private',
      coverPath: '../secret.png',
    })
    expect(result).toEqual({
      title: 'Maze',
      slug: 'maze',
      description: 'Created with Gauntlet Gamesmith.',
      controls: '',
      coverPath: null,
    })
    expect(publicationListing({ title: 'Maze', slug: 'maze' })).toEqual(result)
  })
  it('preserves supplied text and validates it before building', () => {
    expect(
      publicationListing({
        title: 'Maze',
        slug: 'maze',
        description: 'Collect dots.',
        controls: 'Arrows',
      }).description,
    ).toBe('Collect dots.')
    expect(() =>
      publicationListing({ title: 'Maze', slug: 'maze', description: {} }),
    ).toThrow()
  })
  it('uses named shipping artwork when present and needs no cover otherwise', () => {
    const artifact = (paths: string[]) =>
      ({ files: paths.map((path) => ({ path })) }) as GameArtifact
    expect(publicationCover(artifact(['assets/ghost.png']))).toBeNull()
    expect(
      publicationCover(artifact(['assets/preview.webp', 'cover.png'])),
    ).toBe('cover.png')
    expect(publicationCover(artifact(['assets/thumbnail.jpg']))).toBe(
      'assets/thumbnail.jpg',
    )
  })
})
