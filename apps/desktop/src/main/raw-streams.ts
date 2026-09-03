import fs from 'node:fs'
import path from 'node:path'
import { WORKSPACE_METADATA_DIR } from './workspace-metadata'
import { parseAgentMetricId } from '../shared/agent-id'
import type { RevealStreamInput } from '../shared/loop'
import { isRecordId } from '../shared/record-id'
import {
  MAX_CHILD_DIRECTORY_ENTRIES,
  parseArchivedChildStreamName,
  parseChildStreamName,
} from './child-stream-name'
import { assertWorkspaceBoundary } from './workspace-boundary'

const MAX_CODEX_STREAM_DEPTH = 8

export interface RawStreamRoots {
  workspaceDir: string
  runId: string
  sessionId: string | null
  claudeHome: string
  codexHome: string
  /** Only the latest run whose child metrics own the live agent directory. */
  allowLiveChildStream: boolean
}

/** Untrusted transferred/legacy history cannot nominate paths inside private CLI homes. */
export function rawRevealTrustError(playTrusted: boolean): string | null {
  return playTrusted
    ? null
    : 'Untrusted history (imported or created before trust provenance shipped) cannot reveal CLI transcripts; only newly started trusted runs may open raw streams.'
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Raw stream request must be an object.')
  return value as Record<string, unknown>
}

/** Runtime validation for the renderer-to-main request. */
export function parseRevealStreamInput(value: unknown): RevealStreamInput {
  const input = record(value)
  if (!isRecordId(input.runId)) throw new Error('Invalid run id.')
  if (input.stream !== 'stdout' && input.stream !== 'stderr' && input.stream !== 'agent') {
    throw new Error('Invalid raw stream kind.')
  }
  if (input.stream === 'agent') {
    if (typeof input.agentId !== 'string' || input.agentId.length > 320) throw new Error('Agent stream requires a valid agent id.')
    if (!parseAgentMetricId(input.agentId)) {
      throw new Error('This agent does not have a separate raw stream.')
    }
    return { runId: input.runId, stream: input.stream, agentId: input.agentId }
  }
  if (input.agentId !== undefined) throw new Error('Primary stream requests must not include an agent id.')
  return { runId: input.runId, stream: input.stream }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertOwnedDirectoryPath(ownerRoot: string, root: string): void {
  const relative = path.relative(path.resolve(ownerRoot), path.resolve(root))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Raw stream directory escaped its owner.')
  }
  let current = path.resolve(ownerRoot)
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Raw stream directory has an unsafe path component.')
  }
}

function containedFile(ownerRoot: string, root: string, candidate: string): string {
  let ownerPath: string
  let rootPath: string
  let filePath: string
  try {
    assertOwnedDirectoryPath(ownerRoot, root)
    ownerPath = fs.realpathSync(ownerRoot)
    rootPath = fs.realpathSync(root)
    if (!isContained(ownerPath, rootPath)) throw new Error('Raw stream directory escaped its owner.')
    const stat = fs.lstatSync(candidate)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Raw stream is not a regular file.')
    if (stat.nlink !== 1) throw new Error('Raw stream has an unsafe hard link.')
    filePath = fs.realpathSync(candidate)
  } catch (error) {
    throw new Error(`Raw stream is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (filePath === rootPath || !isContained(rootPath, filePath)) {
    throw new Error('Raw stream escaped its owned directory.')
  }
  return filePath
}

function childStream(roots: RawStreamRoots, slug: string): string {
  const root = path.join(roots.workspaceDir, WORKSPACE_METADATA_DIR, 'agents')
  const directories = [path.join(root, roots.runId), ...(roots.allowLiveChildStream ? [root] : [])]
  const matches: string[] = []
  for (const [directoryIndex, directory] of directories.entries()) {
    if (directoryIndex === 0) {
      let handle: fs.Dir | null = null
      try {
        handle = fs.opendirSync(directory)
        let exhausted = false
        for (let seen = 0; seen < MAX_CHILD_DIRECTORY_ENTRIES; seen += 1) {
          const entry = handle.readSync()
          if (!entry) {
            exhausted = true
            break
          }
          const named = parseArchivedChildStreamName(entry.name)
          if (named?.slug !== slug) continue
          matches.push(containedFile(roots.workspaceDir, root, path.join(directory, entry.name)))
        }
        if (!exhausted) throw new Error('Delegated agent archive exceeded its bounded inventory.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      } finally {
        handle?.closeSync()
      }
    }
    for (const harness of ['claude', 'codex'] as const) {
      const candidate = path.join(directory, `${slug}.${harness}.jsonl`)
      try {
        fs.lstatSync(candidate)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new Error(`Raw stream is unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
      // The generated name is validated by the same parser used by readers;
      // no renderer-controlled path fragment is ever joined unchecked.
      if (!parseChildStreamName(path.basename(candidate))) continue
      matches.push(containedFile(roots.workspaceDir, root, candidate))
    }
    if (matches.length > 0) break
  }
  if (matches.length === 0) throw new Error('Delegated agent raw stream was not found.')
  if (matches.length > 1) throw new Error('Delegated agent raw stream is ambiguous.')
  return matches[0]
}

function workflowStream(roots: RawStreamRoots, workflowRunId: string, agentId: string): string {
  if (!roots.sessionId || !/^[a-zA-Z0-9_-]{1,160}$/.test(roots.sessionId)) throw new Error('Workflow session id is unavailable.')
  const project = roots.workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-')
  const root = path.join(roots.claudeHome, 'projects', project, roots.sessionId, 'subagents', 'workflows')
  return containedFile(roots.claudeHome, root, path.join(root, workflowRunId, `agent-${agentId}.jsonl`))
}

function codexStream(roots: RawStreamRoots, threadId: string): string {
  const requestedRoot = path.join(roots.codexHome, 'sessions')
  assertOwnedDirectoryPath(roots.codexHome, requestedRoot)
  const root = fs.realpathSync(requestedRoot)
  if (root !== path.join(fs.realpathSync(roots.codexHome), 'sessions')) {
    throw new Error('Codex stream directory changed canonical identity.')
  }
  let visited = 0
  const matches: string[] = []
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_CODEX_STREAM_DEPTH) throw new Error('Codex stream search exceeded its directory depth limit.')
    let handle: fs.Dir
    try {
      handle = fs.opendirSync(directory)
    } catch {
      return
    }
    try {
      let entry: fs.Dirent | null
      while ((entry = handle.readSync()) !== null) {
        visited += 1
        if (visited > 20_000) throw new Error('Codex stream search exceeded its entry limit.')
        const candidate = path.join(directory, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          walk(candidate, depth + 1)
        } else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
          matches.push(containedFile(roots.codexHome, requestedRoot, candidate))
        }
      }
    } finally {
      handle.closeSync()
    }
  }
  walk(root, 0)
  if (matches.length === 0) throw new Error('Codex agent raw stream was not found.')
  if (matches.length > 1) throw new Error('Codex agent raw stream is ambiguous.')
  return matches[0]
}

/** Resolve only app-owned transcript conventions; the renderer never supplies a path. */
export function resolveRawStreamPath(roots: RawStreamRoots, input: RevealStreamInput): string {
  if (input.runId !== roots.runId || !isRecordId(roots.runId)) throw new Error('Raw stream does not belong to this run.')
  if (input.stream === 'stdout') {
    const root = path.join(roots.workspaceDir, WORKSPACE_METADATA_DIR, 'runs')
    return containedFile(roots.workspaceDir, root, path.join(root, `${roots.runId}.out.ndjson`))
  }
  if (input.stream === 'stderr') {
    const root = path.join(roots.workspaceDir, WORKSPACE_METADATA_DIR, 'runs')
    return containedFile(roots.workspaceDir, root, path.join(root, `${roots.runId}.err.log`))
  }
  const agent = parseAgentMetricId(input.agentId)
  if (agent?.kind === 'child') return childStream(roots, agent.slug)
  if (agent?.kind === 'workflow') return workflowStream(roots, agent.runId, agent.agentId)
  if (agent?.kind === 'codex') return codexStream(roots, agent.threadId)
  throw new Error('This agent does not have a separate raw stream.')
}

/** Revalidate a registry workspace immediately before resolving a reveal path. */
export function resolveProtectedRawStreamPath(
  roots: RawStreamRoots,
  input: RevealStreamInput,
  protectedRoots: readonly string[],
): string {
  const workspaceDir = assertWorkspaceBoundary(roots.workspaceDir, protectedRoots)
  return resolveRawStreamPath({ ...roots, workspaceDir }, input)
}
