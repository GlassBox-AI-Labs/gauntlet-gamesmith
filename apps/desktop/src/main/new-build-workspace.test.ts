import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNewBuildWorkspace, buildWorkspaceFolderName } from './new-build-workspace'

let root: string | null = null

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
})

describe('new build workspace', () => {
  it('derives a filesystem-safe prompt-related name', () => {
    expect(buildWorkspaceFolderName('A neon Pac-Man game')).toBe('a-neon-pac-man-game')
    expect(buildWorkspaceFolderName('  火花  ')).toBe('build')
  })

  it('creates a distinct child folder for every build, including repeated prompts', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-build-root-'))
    const first = createNewBuildWorkspace(root, 'Tower aggro', [])
    const second = createNewBuildWorkspace(root, 'Tower aggro', [])

    expect(first.workspaceDir).toBe(path.join(fs.realpathSync(root), 'tower-aggro'))
    expect(second.workspaceDir).toBe(path.join(fs.realpathSync(root), 'tower-aggro-2'))
    expect(first.workspaceIdentity).not.toEqual(second.workspaceIdentity)
  })
})
