import fs from 'node:fs'
import path from 'node:path'
import { normalizeSessionId } from '../shared/session-id'

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * `<userData>/harnesses/<kind>` — everything the app owns for one CLI.
 *
 * An extra account's config dir is `<kind>/accounts/<id>`, and the app itself
 * symlinks that account's `projects` back to `<kind>/projects` so switching
 * accounts between rounds still continues the same session (see accounts.ts
 * SHARED_ENTRIES). Resolving only against the account dir therefore rejected a
 * link the app had just created, and an implement run on any account but the
 * primary died on its first workflow poll. Returns null for a home that is not
 * under a `harnesses` root — an injected test home keeps the stricter bound.
 */
function harnessTreeRoot(home: string): string | null {
  let current = path.resolve(home)
  while (path.dirname(current) !== current) {
    if (path.basename(path.dirname(current)) === 'harnesses') {
      try {
        return fs.realpathSync(current)
      } catch {
        return null
      }
    }
    current = path.dirname(current)
  }
  return null
}

/**
 * Build a workflow-runtime path from a validated session id. Every existing
 * private-home component is checked without following a symbolic link.
 */
export function safeWorkflowRuntimePath(
  claudeHome: string,
  workspaceDir: string,
  sessionId: string,
  suffix: readonly string[],
): string {
  const safeSession = normalizeSessionId(sessionId)
  if (!safeSession) throw new Error('Invalid Claude session id for workflow path.')
  const absoluteHome = path.resolve(claudeHome)
  try {
    if (fs.lstatSync(absoluteHome).isSymbolicLink()) throw new Error('Claude home must not be a symbolic link.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let canonicalRoot = absoluteHome
  try {
    canonicalRoot = fs.realpathSync(absoluteHome)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // A link is judged by where it lands, not by being a link: anything the app
  // owns for this CLI is in bounds, anything outside it is not.
  const allowedRoots = [canonicalRoot, harnessTreeRoot(absoluteHome)].filter((root): root is string => root !== null)
  const segments = ['projects', workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'), safeSession, ...suffix]
  let current = absoluteHome
  let missing = false
  for (const segment of segments) {
    current = path.join(current, segment)
    if (missing) continue
    try {
      const link = fs.lstatSync(current).isSymbolicLink()
      const canonical = fs.realpathSync(current)
      if (!allowedRoots.some((root) => contained(root, canonical))) {
        throw new Error(
          link
            ? `Workflow path component is a symbolic link out of the harness home: ${segment}`
            : `Workflow path escapes the selected Claude home: ${segment}`,
        )
      }
      current = canonical
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true
      else throw error
    }
  }
  return current
}
