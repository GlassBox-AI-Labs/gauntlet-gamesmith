import { describe, expect, it } from 'vitest'
import { publicationListing } from './publication-listing'
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
})
