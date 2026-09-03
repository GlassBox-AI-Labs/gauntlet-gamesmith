import fs from 'node:fs'
import path from 'node:path'
import { normalizeSessionId } from '../shared/session-id'

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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
  const segments = ['projects', workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'), safeSession, ...suffix]
  let current = absoluteHome
  let missing = false
  for (const segment of segments) {
    current = path.join(current, segment)
    if (missing) continue
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error(`Workflow path component is a symbolic link: ${segment}`)
      const canonical = fs.realpathSync(current)
      if (!contained(canonicalRoot, canonical)) throw new Error(`Workflow path escapes the selected Claude home: ${segment}`)
      current = canonical
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true
      else throw error
    }
  }
  return current
}
