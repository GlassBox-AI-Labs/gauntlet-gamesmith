import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertLoopWorkspaceIdentity, assertWorkspaceBoundary, captureWorkspaceIdentity } from './workspace-boundary'

const roots: string[] = []
const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-boundary-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('assertWorkspaceBoundary', () => {
  it('rejects exact, ancestor, descendant, root, and symlink overlaps', () => {
    const root = makeRoot()
    const privateRoot = path.join(root, 'app-data', 'harnesses', 'claude')
    fs.mkdirSync(privateRoot, { recursive: true })
    expect(() => assertWorkspaceBoundary(privateRoot, [privateRoot])).toThrow(/overlaps private app data/)
    expect(() => assertWorkspaceBoundary(root, [privateRoot])).toThrow(/overlaps private app data/)
    expect(() => assertWorkspaceBoundary(path.join(privateRoot, 'project'), [privateRoot])).toThrow(/overlaps private app data/)
    expect(() => assertWorkspaceBoundary(path.parse(root).root, [privateRoot])).toThrow(/filesystem root/)
    const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`)
    fs.symlinkSync(privateRoot, alias)
    expect(() => assertWorkspaceBoundary(alias, [privateRoot])).toThrow(/overlaps private app data/)
    fs.unlinkSync(alias)
  })

  it('accepts a disjoint project', () => {
    const root = makeRoot()
    const project = path.join(root, 'project')
    const privateRoot = path.join(root, 'private')
    fs.mkdirSync(project)
    fs.mkdirSync(privateRoot)
    expect(assertWorkspaceBoundary(project, [privateRoot])).toBe(fs.realpathSync(project))
  })

  it('pins the exact canonical workspace directory identity', () => {
    const root = makeRoot()
    const project = path.join(root, 'project')
    const privateRoot = path.join(root, 'private')
    fs.mkdirSync(project)
    fs.mkdirSync(privateRoot)
    const captured = captureWorkspaceIdentity(project, [privateRoot])
    expect(assertLoopWorkspaceIdentity(captured, [privateRoot])).toBe(fs.realpathSync(project))

    fs.renameSync(project, `${project}-original`)
    fs.mkdirSync(project)
    expect(() => assertLoopWorkspaceIdentity(captured, [privateRoot])).toThrow(/changed identity/)
  })
})
