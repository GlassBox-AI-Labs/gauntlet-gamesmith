import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ContextFolder } from '../shared/build-context'

/** Opaque folder IDs limit Finder actions to folders attached in this session. */
export function createContextFolders() {
  const folders = new Map<string, { folder: ContextFolder; dev: number; ino: number }>()
  return {
    add(value: unknown): ContextFolder | null {
      if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || value.includes('\0')) {
        throw new Error('Choose a local file or folder.')
      }
      const resolved = fs.realpathSync(value)
      const stat = fs.statSync(resolved)
      if (!stat.isDirectory()) return null
      const existing = [...folders.values()].find(({ folder }) => folder.path === resolved)
      if (existing) return existing.folder
      if (folders.size >= 100) throw new Error('Attach at most 100 folders per session.')
      const folder = { id: crypto.randomUUID(), name: path.basename(resolved) || resolved, path: resolved }
      folders.set(folder.id, { folder, dev: stat.dev, ino: stat.ino })
      return folder
    },
    resolve(value: unknown): string {
      if (typeof value !== 'string' || value.length > 100) throw new Error('Invalid folder.')
      const saved = folders.get(value)
      if (!saved) throw new Error('Attach this folder before opening it.')
      const stat = fs.lstatSync(saved.folder.path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== saved.dev || stat.ino !== saved.ino) {
        throw new Error('The folder moved or changed. Attach it again.')
      }
      return saved.folder.path
    },
  }
}
