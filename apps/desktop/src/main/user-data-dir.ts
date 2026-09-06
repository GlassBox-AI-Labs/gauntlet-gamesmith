import path from 'node:path'

export const USER_DATA_SWITCH = '--gauntlet-user-data'

/**
 * An explicit profile directory, passed as `--gauntlet-user-data=/some/path`.
 *
 * Everything the app owns — the build registry, the harness logins, round
 * revisions, and the single-instance lock — lives under the user-data
 * directory. Pointing at a different one therefore gives a genuinely separate
 * instance that can run beside the normal app instead of being refused by the
 * lock. Chrome and VS Code spell this `--user-data-dir`; the name is prefixed
 * here because Electron consumes Chromium's own switch before app code runs.
 *
 * Returns null when the switch is absent. Throws on a switch that is present
 * but unusable, so a mistyped profile fails loudly at startup rather than
 * quietly writing into the real one.
 */
export function resolveUserDataOverride(argv: readonly string[]): string | null {
  const prefix = `${USER_DATA_SWITCH}=`
  const matches = argv.filter((entry) => entry === USER_DATA_SWITCH || entry.startsWith(prefix))
  if (matches.length === 0) return null
  if (matches.length > 1) throw new Error(`${USER_DATA_SWITCH} was given more than once.`)

  const [match] = matches
  if (match === USER_DATA_SWITCH) throw new Error(`${USER_DATA_SWITCH} needs a path, as ${USER_DATA_SWITCH}=/some/path.`)

  const value = match.slice(prefix.length).trim()
  if (!value) throw new Error(`${USER_DATA_SWITCH} needs a path, as ${USER_DATA_SWITCH}=/some/path.`)
  if (!path.isAbsolute(value)) throw new Error(`${USER_DATA_SWITCH} must be an absolute path.`)
  return path.resolve(value)
}
