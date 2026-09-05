import { describe, expect, it } from 'vitest'
import { USER_DATA_SWITCH, resolveUserDataOverride } from './user-data-dir'

describe('resolveUserDataOverride', () => {
  it('returns null when the switch is absent', () => {
    expect(resolveUserDataOverride(['electron', '.'])).toBeNull()
  })

  it('reads an absolute path', () => {
    expect(resolveUserDataOverride(['electron', '.', `${USER_DATA_SWITCH}=/tmp/profile`])).toBe('/tmp/profile')
  })

  it('normalizes a path with redundant segments', () => {
    expect(resolveUserDataOverride([`${USER_DATA_SWITCH}=/tmp/profile/../other`])).toBe('/tmp/other')
  })

  it('rejects a relative path rather than guessing a root', () => {
    expect(() => resolveUserDataOverride([`${USER_DATA_SWITCH}=profile`])).toThrow(/absolute/)
  })

  it('rejects the switch with no value', () => {
    expect(() => resolveUserDataOverride([USER_DATA_SWITCH])).toThrow(/needs a path/)
    expect(() => resolveUserDataOverride([`${USER_DATA_SWITCH}=`])).toThrow(/needs a path/)
    expect(() => resolveUserDataOverride([`${USER_DATA_SWITCH}=   `])).toThrow(/needs a path/)
  })

  it('rejects a repeated switch instead of silently picking one', () => {
    expect(() => resolveUserDataOverride([`${USER_DATA_SWITCH}=/tmp/a`, `${USER_DATA_SWITCH}=/tmp/b`]))
      .toThrow(/more than once/)
  })

  it('ignores an unrelated switch with a similar name', () => {
    expect(resolveUserDataOverride(['--gauntlet-user-database=/tmp/x'])).toBeNull()
  })
})
