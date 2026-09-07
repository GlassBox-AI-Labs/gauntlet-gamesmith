import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assetPath, boundedText, MAX_ARTIFACT_BYTES, MAX_FILES, object, type GameArtifact } from './index'
export const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Revalidate every byte at the receiving seam; never trust a desktop-generated manifest. */
export function validateArtifact(value: unknown): { artifact: GameArtifact; digest: string; bytes: number } {
  const v = object(value)
  if (v.version !== 1 || !Array.isArray(v.files) || !v.files.length || v.files.length > MAX_FILES) throw new Error('Invalid artifact manifest.')
  const sourceRevision = boundedText(v.sourceRevision, 'source revision', 128)
  let bytes = 0
  const seen = new Set<string>()
  const files = v.files.map(raw => {
    const f = object(raw), file = assetPath(f.path)
    if (seen.has(file.toLowerCase())) throw new Error('Duplicate asset path.')
    seen.add(file.toLowerCase())
    if (typeof f.data !== 'string' || f.data.length > MAX_ARTIFACT_BYTES * 4 / 3 + 4 || f.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) throw new Error('Invalid base64 asset.')
    const body = Buffer.from(f.data, 'base64')
    bytes += body.length
    if (bytes > MAX_ARTIFACT_BYTES || body.toString('base64') !== f.data) throw new Error('Artifact exceeds limits or contains invalid data.')
    if (digest(body) !== f.sha256) throw new Error(`Asset checksum mismatch: ${file}`)
    return { path: file, data: f.data, sha256: String(f.sha256) }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (!files.some(f => f.path === 'index.html')) throw new Error('Build must contain index.html.')
  const artifact: GameArtifact = { version: 1, sourceRevision, files }
  return { artifact, digest: digest(JSON.stringify(artifact)), bytes }
}

/** Only package a chosen shipping directory. Links, source, and unknown file types fail closed. */
export async function packDirectory(directory: string, sourceRevision: string): Promise<GameArtifact> {
  const root = await fs.realpath(directory), files: GameArtifact['files'] = []
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Build directory cannot be a symlink.')
  let total = 0, entries = 0
  async function visit(dir: string): Promise<void> {
    const handle = await fs.opendir(dir)
    for await (const entry of handle) {
      if (++entries > MAX_FILES * 2) throw new Error('Too many build entries.')
      const target = path.join(dir, entry.name), relative = path.relative(root, target).split(path.sep).join('/')
      const stat = await fs.lstat(target)
      if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile()) throw new Error(`Linked build entry: ${relative}`)
      const canonical = await fs.realpath(target)
      if (!canonical.startsWith(`${root}${path.sep}`)) throw new Error('Build entry escapes the shipping directory.')
      if (entry.name.startsWith('.') || /^(node_modules|reference|critique)$/i.test(entry.name)) throw new Error(`Private directory in build: ${relative}`)
      if (stat.isDirectory()) { await visit(target); continue }
      if (!stat.isFile()) throw new Error(`Special file in build: ${relative}`)
      assetPath(relative)
      if (files.length >= MAX_FILES || (total += stat.size) > MAX_ARTIFACT_BYTES) throw new Error('Build exceeds publication limits.')
      const fd = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const actual = await fd.stat()
        if (actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size !== stat.size) throw new Error('Build changed while packaging.')
        const data = Buffer.alloc(stat.size)
        let offset = 0
        while (offset < data.length) {
          const read = await fd.read(data, offset, data.length - offset, offset)
          if (!read.bytesRead) throw new Error('Build changed while packaging.')
          offset += read.bytesRead
        }
        const after = await fd.stat()
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Build changed while packaging.')
        files.push({ path: relative, data: data.toString('base64'), sha256: digest(data) })
      } finally { await fd.close() }
    }
  }
  await visit(root)
  return validateArtifact({ version: 1, sourceRevision, files }).artifact
}
