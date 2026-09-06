import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@gauntlet/db/types'
import { Catalog } from './catalog'
import { beginSchema } from '../contracts'
describe('saved-round publication contract', () => {
  it('requires exact source provenance and rejects a browser-supplied artifact body', () => {
    const source = {
      loopId: '4be788b6-3a80-4882-bf31-47eb265c3b21',
      runId: '1bc97afd-8754-44b4-8c85-38cf848ec8be',
      round: 2,
      revision: 'a'.repeat(40),
    }
    const input = {
      gameId: source.loopId,
      requestKey: source.runId,
      digest: 'b'.repeat(64),
      listing: {
        title: 'Maze',
        slug: 'maze',
        description: 'A maze',
        controls: 'Arrows',
        coverPath: null,
      },
      source,
    }
    expect(beginSchema.parse(input).source).toEqual(source)
    expect(beginSchema.safeParse({ ...input, source: undefined }).success).toBe(
      false,
    )
    expect(
      beginSchema.safeParse({ ...input, artifact: { files: [] } }).success,
    ).toBe(false)
  })
  it('verifies private previews across independent server instances with the same key', () => {
    const client = {} as SupabaseClient<Database>,
      a = new Catalog(client, 'a'.repeat(64), vi.fn()),
      b = new Catalog(client, 'a'.repeat(64), vi.fn())
    const token = a.previewToken('release-a')
    expect(b.validPreview('release-a', token)).toBe(true)
    expect(b.validPreview('release-b', token)).toBe(false)
    expect(b.validPreview('release-a', token + '.extra')).toBe(false)
  })
})
