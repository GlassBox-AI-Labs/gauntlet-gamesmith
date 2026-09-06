import fs from 'node:fs'
import path from 'node:path'
import type { ArtifactLocation, ArtifactLocationKind, GameAssetGalleryItem } from '../shared/loop'
import { referenceRootForLoop } from '../shared/reference-path'

const MAX_ITEMS = 10_000
const MAX_GALLERY_ITEMS = 500
const ASSET_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SUPPORT_FACTORIES = new Set(['index', 'sculpt-types'])
const PREVIEW_FILES = ['preview.png', 'render-framed.png', 'render-clean.png', 'orbit-0.png', 'comparison.png'] as const

const LABELS: Record<ArtifactLocationKind, string> = {
  workspace: 'Project folder',
  assets: 'Generated game assets',
  'sculpt-evidence': 'Sculptor evidence',
  reference: 'Frozen Reference Pack',
  critique: 'Critique evidence',
}

export function artifactRelativePath(kind: ArtifactLocationKind, loopId: string): string {
  if (kind === 'workspace') return '.'
  if (kind === 'assets') return path.join('src', 'assets')
  if (kind === 'sculpt-evidence') return '.img2threejs'
  if (kind === 'reference') return referenceRootForLoop(loopId, true)
  return 'critique'
}

export function parseArtifactLocationKind(value: unknown): ArtifactLocationKind {
  if (value === 'workspace' || value === 'assets' || value === 'sculpt-evidence' || value === 'reference' || value === 'critique') return value
  throw new Error('Unknown artifact location.')
}

/** Resolve an existing real directory without allowing a nested symlink to escape the workspace. */
export function resolveArtifactLocation(workspaceDir: string, loopId: string, kind: ArtifactLocationKind): string | null {
  const workspace = fs.realpathSync(workspaceDir)
  const candidate = path.resolve(workspace, artifactRelativePath(kind, loopId))
  let resolved: string
  try {
    const linked = fs.lstatSync(candidate)
    if (!linked.isDirectory() || linked.isSymbolicLink()) return null
    resolved = fs.realpathSync(candidate)
  } catch {
    return null
  }
  const relative = path.relative(workspace, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved
}

function immediateItemCount(directory: string | null): number {
  if (!directory) return 0
  let count = 0
  const opened = fs.opendirSync(directory)
  try {
    for (let entry = opened.readSync(); entry; entry = opened.readSync()) {
      if (entry.isSymbolicLink()) continue
      count += 1
      if (count >= MAX_ITEMS) break
    }
  } finally {
    opened.closeSync()
  }
  return count
}

export function listArtifactLocations(workspaceDir: string, loopId: string): ArtifactLocation[] {
  const kinds: ArtifactLocationKind[] = ['assets', 'sculpt-evidence', 'reference', 'critique', 'workspace']
  return kinds.map((kind) => {
    const relativePath = artifactRelativePath(kind, loopId)
    const directory = resolveArtifactLocation(workspaceDir, loopId, kind)
    return {
      kind,
      label: LABELS[kind],
      relativePath,
      exists: directory != null,
      itemCount: immediateItemCount(directory),
    }
  })
}

function assetLabel(slug: string): string {
  return slug.split('-').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(' ')
}

function safeEvidenceDirectory(root: string | null, slug: string): string | null {
  if (!root) return null
  const candidate = path.join(root, slug)
  try {
    const entry = fs.lstatSync(candidate)
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null
    const resolved = fs.realpathSync(candidate)
    const relative = path.relative(root, resolved)
    return relative === slug && !path.isAbsolute(relative) ? resolved : null
  } catch {
    return null
  }
}

function safePreview(directory: string | null): string | null {
  if (!directory) return null
  for (const filename of PREVIEW_FILES) {
    try {
      const entry = fs.lstatSync(path.join(directory, filename))
      if (entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1) return filename
    } catch {
      // A sculptor may emit only some of the supported evidence names.
    }
  }
  return null
}

/** List procedural factories and their safest available rendered evidence. */
export function listGameAssetGallery(workspaceDir: string, loopId: string): GameAssetGalleryItem[] {
  const assets = resolveArtifactLocation(workspaceDir, loopId, 'assets')
  if (!assets) return []
  const evidenceRoot = resolveArtifactLocation(workspaceDir, loopId, 'sculpt-evidence')
  const rows: GameAssetGalleryItem[] = []
  const entries = fs.readdirSync(assets, { withFileTypes: true })
  for (const entry of entries) {
    if (rows.length >= MAX_GALLERY_ITEMS) break
    if (!entry.isFile() || entry.isSymbolicLink() || path.extname(entry.name) !== '.ts') continue
    const slug = path.basename(entry.name, '.ts')
    if (!ASSET_SLUG.test(slug) || SUPPORT_FACTORIES.has(slug)) continue
    const evidence = safeEvidenceDirectory(evidenceRoot, slug)
    const preview = safePreview(evidence)
    rows.push({
      slug,
      label: assetLabel(slug),
      factoryPath: path.posix.join('src', 'assets', entry.name),
      evidencePath: evidence ? path.posix.join('.img2threejs', slug) : null,
      previewPath: preview ? path.posix.join('.img2threejs', slug, preview) : null,
      evidenceCount: immediateItemCount(evidence),
    })
  }
  return rows.sort((left, right) => left.label.localeCompare(right.label))
}
