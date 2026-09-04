import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNewRunWorkspace, runWorkspaceFolderName } from './new-run-workspace'

let root: string | null = null

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
})

describe('new run workspace', () => {
  it('derives a filesystem-safe prompt-related name', () => {
    expect(runWorkspaceFolderName('A neon Pac-Man game')).toBe('a-neon-pac-man-game')
    expect(runWorkspaceFolderName('  火花  ')).toBe('run')
  })

  it('creates a distinct child folder for every run, including repeated prompts', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-run-root-'))
    const first = createNewRunWorkspace(root, 'Tower aggro', [])
    const second = createNewRunWorkspace(root, 'Tower aggro', [])

    expect(first.workspaceDir).toBe(path.join(fs.realpathSync(root), 'tower-aggro'))
    expect(second.workspaceDir).toBe(path.join(fs.realpathSync(root), 'tower-aggro-2'))
    expect(first.workspaceIdentity).not.toEqual(second.workspaceIdentity)
  })
})
