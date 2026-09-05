import fs from 'node:fs'
import path from 'node:path'
import type { LoopModels, ReferencePack } from '../shared/loop'
import { parseCast } from './asset-phase'
import { redactLogText } from '../shared/redact-log'
import { referencePackDir } from '../shared/reference-path'
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from './media-limits'
import type { WorkspaceRootIdentity } from './workspace-boundary'
import {
  boundedOwnedDirectoryEntries,
  captureOwnedDirectory,
  ownedFileStat,
  readOwnedFile,
  type OwnedDirectoryBoundary,
} from './owned-tree'

export { referencePackDir } from '../shared/reference-path'

const IMAGE = /\.(png|jpe?g|webp|gif)$/i
const VIDEO = /\.(webm|mp4|mov|mkv)$/i
const MAX_FILES = 300
const MAX_ENTRIES = 2_000
const MAX_PROJECTED_IMAGE_BYTES = 128 * 1024 * 1024
const MAX_STILLS = 24
const MAX_MOTION = 24
const MAX_JOURNEY = 12
const MAX_OBJECTS = 64
const MAX_VIDEOS = 2

function artifactRoot(workspaceDir: string, relativeDir: string, expectedWorkspace?: WorkspaceRootIdentity): OwnedDirectoryBoundary | null {
  if (!relativeDir || relativeDir.includes('\\') || path.posix.isAbsolute(relativeDir)) return null
  const segments = relativeDir.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  try {
    const workspace = fs.realpathSync(workspaceDir)
    const boundary = captureOwnedDirectory(workspace, path.join(workspace, ...segments), expectedWorkspace)
    const relative = path.relative(workspace, boundary.path)
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? boundary : null
  } catch {
    return null
  }
}

function readText(directory: OwnedDirectoryBoundary, name: string, maxChars = 12_000, maxBytes = 128 * 1024): string | null {
  try {
    return readOwnedFile(directory, name, maxBytes, name).toString('utf8').slice(0, maxChars)
  } catch {
    return null
  }
}

function filesBelow(workspaceDir: string, relativeDir: string, expectedWorkspace?: WorkspaceRootIdentity): {
  root: OwnedDirectoryBoundary | null
  files: string[]
  sizes: Map<string, number>
  truncated: boolean
  unsafePaths: boolean
} {
  const root = artifactRoot(workspaceDir, relativeDir, expectedWorkspace)
  const files: string[] = []
  const sizes = new Map<string, number>()
  let truncated = false
  let unsafePaths = false
  if (!root) return { root, files, sizes, truncated, unsafePaths }
  const canonicalWorkspace = root?.ownerRoot ?? fs.realpathSync(workspaceDir)
  const pending = [root]
  let visited = 0
  while (pending.length > 0 && !truncated) {
    const directory = pending.pop()!
    let entries: fs.Dirent[]
    try {
      if (visited >= MAX_ENTRIES) {
        truncated = true
        break
      }
      const remaining = MAX_ENTRIES - visited
      const bounded = boundedOwnedDirectoryEntries(directory, remaining)
      entries = bounded.entries
      visited += entries.length
      if (bounded.truncated) truncated = true
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true
        break
      }
      if (entry.isSymbolicLink()) continue
      const next = path.join(directory.path, entry.name)
      if (entry.isDirectory()) {
        try {
          pending.push(captureOwnedDirectory(canonicalWorkspace, next, expectedWorkspace))
        } catch {
          unsafePaths = true
        }
      }
      else if (entry.isFile()) {
        try {
          const stat = ownedFileStat(directory, entry.name)
          const relative = path.relative(canonicalWorkspace, next).split(path.sep).join('/')
          if (redactLogText(relative) !== relative) {
            unsafePaths = true
            continue
          }
          files.push(relative)
          sizes.set(relative, stat.size)
        } catch {
          /* the producer may still be writing; a later scan can include it */
        }
      }
    }
  }
  return { root, files: files.sort(), sizes, truncated, unsafePaths }
}

function safeManifestFile(value: unknown, packRoot: string, files: Set<string>): string | null {
  if (typeof value !== 'string' || !value || value.length > 1_024 || value.includes('\\')) return null
  const normalized = path.posix.normalize(value.replace(/^\.\//, ''))
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null
  return files.has(`${packRoot}/${normalized}`) ? normalized : null
}

/**
 * True when cast.md opens by saying the game has nothing to sculpt.
 *
 * Read from the first real line rather than anywhere in the file, so the word
 * has to be the document's answer — "None — the look is neon walls and bloom"
 * counts, a stray "none of these" halfway down a list does not.
 */
function declaresNoCast(castMd: string): boolean {
  const first = castMd.split(/\r?\n/).map((line) => line.replace(/^[#\-*\s]+/, '').trim()).find(Boolean) ?? ''
  return /^none\b/i.test(first)
}

/** The sole filesystem seam for Reference Pack discovery and validation. */
export function scanReferencePack(workspaceDir: string, root: string, expectedWorkspace?: WorkspaceRootIdentity & { models?: Pick<LoopModels, 'referenceMode'> }): ReferencePack {
  const filesOnly = expectedWorkspace?.models?.referenceMode === 'files'
  const inventory = filesBelow(workspaceDir, root, expectedWorkspace)
  const { files, sizes, truncated, unsafePaths } = inventory
  const absoluteRoot = inventory.root
  const canonicalWorkspace = fs.realpathSync(workspaceDir)
  const under = (directory: string, pattern: RegExp): string[] =>
    files.filter((file) => file.startsWith(`${root}/${directory}/`) && pattern.test(file))
  let projectionTruncated = truncated
  let projectedImageBytes = 0
  const boundedImages = (directory: string, limit: number): string[] => {
    const result: string[] = []
    for (const file of under(directory, IMAGE)) {
      if (result.length >= limit) {
        projectionTruncated = true
        break
      }
      try {
        const size = sizes.get(file)
        if (size === undefined || size > MAX_IMAGE_BYTES) {
          projectionTruncated = true
          continue
        }
        if (projectedImageBytes + size > MAX_PROJECTED_IMAGE_BYTES) {
          projectionTruncated = true
          continue
        }
        projectedImageBytes += size
        result.push(file)
      } catch {
        projectionTruncated = true
      }
    }
    return result
  }
  const images = boundedImages('images', MAX_STILLS)
  const motion = boundedImages('motion', MAX_MOTION)
  const journey = boundedImages('journey', MAX_JOURNEY)
  const objects = boundedImages('objects', MAX_OBJECTS)
  const allVideos = under('video', VIDEO)
  if (allVideos.length > MAX_VIDEOS) projectionTruncated = true
  const videos: string[] = []
  for (const file of allVideos) {
    if (videos.length >= MAX_VIDEOS) break
    try {
      const size = sizes.get(file)
      if (size === undefined || size > MAX_VIDEO_BYTES) {
        projectionTruncated = true
        continue
      }
      videos.push(file)
    } catch {
      projectionTruncated = true
    }
  }
  const readmeRaw = absoluteRoot ? readText(absoluteRoot, 'README.md') : null
  const readme = readmeRaw == null ? null : redactLogText(readmeRaw)
  // The manifest is parsed, not just displayed, so it must never be truncated
  // mid-document — deep-research manifests list every consulted source and
  // easily outgrow the display cap.
  const manifestRaw = absoluteRoot ? readText(absoluteRoot, 'manifest.json', 1_000_000, 1_000_000) : null
  const manifest = manifestRaw == null ? null : redactLogText(manifestRaw)
  const journeyMdRaw = absoluteRoot ? readText(absoluteRoot, 'journey.md') : null
  const storyMdRaw = absoluteRoot ? readText(absoluteRoot, 'story.md') : null
  const researchMdRaw = absoluteRoot ? readText(absoluteRoot, 'research.md') : null
  const castMdRaw = absoluteRoot ? readText(absoluteRoot, 'cast.md') : null
  const journeyMd = journeyMdRaw == null ? null : redactLogText(journeyMdRaw)
  const storyMd = storyMdRaw == null ? null : redactLogText(storyMdRaw)
  const researchMd = researchMdRaw == null ? null : redactLogText(researchMdRaw)
  const castMd = castMdRaw == null ? null : redactLogText(castMdRaw)
  const issues: string[] = []
  const warnings: string[] = []
  if (truncated) issues.push(`inventory exceeds ${MAX_FILES} files or ${MAX_ENTRIES} entries and was truncated`)
  if (unsafePaths) warnings.push('credential-shaped artifact paths were omitted from the display projection')
  if (projectionTruncated && !truncated) warnings.push('projected media exceeds its byte or display-count safety limit and was truncated')
  if (!filesOnly && images.length < 8) issues.push(`needs at least 8 stills (${images.length} found)`)
  if (!filesOnly && motion.length < 8) issues.push(`needs at least 8 motion frames (${motion.length} found)`)
  if (!filesOnly && videos.length < 1) issues.push('needs a gameplay video')
  if (!filesOnly && journey.length < 4) issues.push(`needs at least 4 ordered journey shots (${journey.length} found)`)
  if (!researchMd?.trim()) issues.push('needs research.md with the deep-research findings')
  else if (!/expert gameplay dossier/i.test(researchMd)) {
    issues.push('research.md needs an Expert gameplay dossier for the critic')
  }
  if (!journeyMd?.trim()) issues.push('needs journey.md with the main menu → Level 1 walkthrough')
  if (!storyMd?.trim()) issues.push('needs story.md with the premise, progression, and captured dialog')
  if (!readme?.trim()) issues.push('needs README.md with the target brief')
  else if (!/progression model:\s*(?:level-based|non-level-based)/i.test(readme)) {
    issues.push('README.md needs a level-based or non-level-based progression classification')
  }
  if (!manifestRaw?.trim()) issues.push('needs manifest.json with source attribution')
  else {
    try {
      const value: unknown = JSON.parse(manifestRaw)
      if (!value || typeof value !== 'object' || Array.isArray(value)) issues.push('manifest.json must be an object')
      else {
        const manifestRecord = value as Record<string, unknown>
        if (typeof manifestRecord.title !== 'string' || !manifestRecord.title.trim() || manifestRecord.title.length > 500) {
          issues.push('manifest.json needs a bounded reference title')
        }
        const sources = manifestRecord.sources
        if (!Array.isArray(sources) || sources.length === 0) issues.push('manifest.json needs a non-empty sources array')
        else if (sources.length > 500) issues.push('manifest.json exceeds the 500-source safety limit')
        else {
          const knownFiles = new Set(files)
          const attributed = new Set<string>()
          let invalid = false
          for (const source of sources) {
            if (!source || typeof source !== 'object' || Array.isArray(source)) {
              invalid = true
              break
            }
            const entry = source as Record<string, unknown>
            try {
              const url = typeof entry.url === 'string' && entry.url.length <= 4_096 ? new URL(entry.url) : null
              if (filesOnly) {
                if (entry.url !== undefined || typeof entry.file !== 'string' || !entry.file.startsWith('supplied/') || !safeManifestFile(entry.file, root, knownFiles)) invalid = true
              } else if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) invalid = true
            } catch {
              invalid = true
            }
            if (entry.note !== undefined && (typeof entry.note !== 'string' || entry.note.length > 4_000)) invalid = true
            if (entry.file !== undefined) {
              const file = safeManifestFile(entry.file, root, knownFiles)
              if (!file) invalid = true
              else attributed.add(file)
            }
          }
          if (invalid) issues.push('manifest.json contains an invalid source entry')
          const downloaded = files
            .map((file) => file.slice(root.length + 1))
            .filter((file) => /^(?:images|motion|video|journey|objects)\//.test(file))
          const missing = downloaded.filter((file) => !attributed.has(file))
          if (missing.length > 0) issues.push(`manifest.json lacks attribution for ${missing.length} downloaded evidence file${missing.length === 1 ? '' : 's'}`)
        }
      }
    } catch {
      issues.push('manifest.json is not valid JSON')
    }
  }
  const cast = parseCast(manifestRaw)
  // An empty cast is legal — a game whose look lives in shaders and motion has
  // nothing to sculpt — so the pack is only faulted for a cast list that exists
  // in prose but not in the manifest, or for entries that name no frame.
  if (!castMd?.trim()) issues.push('needs cast.md listing the objects worth sculpting (write "none" if the game has none)')
  else if (cast.length === 0 && !declaresNoCast(castMd)) {
    issues.push('cast.md lists objects but manifest.json has no matching "cast" array')
  }
  const castNoStills = cast.filter((entry) => entry.stills.length === 0).map((entry) => entry.name)
  if (castNoStills.length > 0) issues.push(`cast entries name no reference frame: ${castNoStills.join(', ')}`)
  return {
    root,
    ready: issues.length === 0,
    issues,
    warnings,
    images,
    motion,
    videos,
    journey,
    objects,
    readme,
    manifest,
    journeyMd,
    storyMd,
    researchMd,
    castMd,
    castCount: cast.length,
  }
}
