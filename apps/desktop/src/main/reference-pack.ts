import fs from 'node:fs'
import path from 'node:path'
import type { ReferencePack } from '../shared/loop'

const IMAGE = /\.(png|jpe?g|webp|gif)$/i
const VIDEO = /\.(webm|mp4|mov)$/i
const MAX_FILES = 300

export function referencePackDir(loopId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(loopId)) throw new Error('Invalid loop id for Reference Pack path.')
  return path.posix.join('reference', loopId)
}

function readText(filePath: string, max = 12_000): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, max)
  } catch {
    return null
  }
}

function filesBelow(workspaceDir: string, relativeDir: string): string[] {
  const root = path.join(workspaceDir, relativeDir)
  const files: string[] = []
  const visit = (absolute: string): void => {
    if (files.length >= MAX_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break
      const next = path.join(absolute, entry.name)
      if (entry.isDirectory()) visit(next)
      else if (entry.isFile()) files.push(path.relative(workspaceDir, next).split(path.sep).join('/'))
    }
  }
  visit(root)
  return files.sort()
}

/** The sole filesystem seam for Reference Pack discovery and validation. */
export function scanReferencePack(workspaceDir: string, root: string): ReferencePack {
  const files = filesBelow(workspaceDir, root)
  const under = (directory: string, pattern: RegExp): string[] =>
    files.filter((file) => file.startsWith(`${root}/${directory}/`) && pattern.test(file))
  const images = under('images', IMAGE)
  const motion = under('motion', IMAGE)
  const videos = under('video', VIDEO)
  const readme = readText(path.join(workspaceDir, root, 'README.md'))
  const manifest = readText(path.join(workspaceDir, root, 'manifest.json'))
  const issues: string[] = []
  if (images.length < 8) issues.push(`needs at least 8 stills (${images.length} found)`)
  if (motion.length < 8) issues.push(`needs at least 8 motion frames (${motion.length} found)`)
  if (videos.length < 1) issues.push('needs a gameplay video')
  if (!readme?.trim()) issues.push('needs README.md with the target brief')
  if (!manifest?.trim()) issues.push('needs manifest.json with source attribution')
  else {
    try {
      const value = JSON.parse(manifest) as Record<string, unknown>
      if (!Array.isArray(value.sources) || value.sources.length === 0) issues.push('manifest.json needs a non-empty sources array')
    } catch {
      issues.push('manifest.json is not valid JSON')
    }
  }
  return { root, ready: issues.length === 0, issues, images, motion, videos, readme, manifest }
}
