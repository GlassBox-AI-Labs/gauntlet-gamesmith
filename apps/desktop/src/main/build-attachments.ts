import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { MAX_CONTEXT_BYTES, MAX_CONTEXT_FILE_BYTES, MAX_CONTEXT_FILES, type BuildAttachment } from '../shared/attachments'
import { redactLogText } from '../shared/redact-log'
import { assertOwnedDirectoryBoundary, boundedOwnedDirectoryEntries, captureOwnedDirectory, readOwnedFile } from './owned-tree'
import { referencePackFingerprint } from './phase-contracts'

const IMAGE_MIMES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }
const EXCLUDED = /^(?:\.|node_modules$|vendor$|dist$|build$|credentials?(?:\.|$)|auth\.json$|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|keychain|keychain-db)$)/i
const ALLOWED = /\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|md|txt|csv|json|mp4|webm|mov|mp3|wav|ogg|glb|gltf|obj|ts|tsx|js|jsx|css|html|yaml|yml)$/i
interface StoredFile { name: string; bytes: Buffer }
interface StoredAttachment { item: BuildAttachment; files: StoredFile[]; source: string; dev: number; ino: number }
export interface PreparedContext { publish(workspace: string, referenceDir: string): { fingerprint: string; files: number; bytes: number; paths: string[] } }

function safeName(name: string): string {
  const safe = redactLogText(name).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240)
  if (!safe || safe !== name) throw new Error('Rename the attachment to a short name without secrets or control characters.')
  return safe
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_FILES || value.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw new Error('Invalid attachment selection.')
  return [...new Set(value)]
}

/** Bounded snapshots: originals are read once, copies are published before any agent starts. */
export function createBuildAttachments(protectedRoots: () => string[]) {
  const stored = new Map<string, StoredAttachment>()
  function get(value: unknown): StoredAttachment {
    const id = ids([value])[0]
    const entry = stored.get(id)
    if (!entry) throw new Error('Attachment is no longer available. Add it again.')
    return entry
  }
  return {
    add(value: unknown): BuildAttachment[] {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CONTEXT_FILES) throw new Error('Choose between 1 and 100 files or folders.')
      let totalBytes = [...stored.values()].reduce((sum, entry) => sum + entry.item.bytes, 0)
      let totalFiles = [...stored.values()].reduce((sum, entry) => sum + entry.item.files, 0)
      const added: StoredAttachment[] = []
      for (const input of value) {
        if (typeof input !== 'string' || input.length > 8192 || !path.isAbsolute(input) || input.includes('\0')) throw new Error('Choose a local file or folder.')
        if (fs.lstatSync(input).isSymbolicLink()) throw new Error('Attach original files, not symbolic links.')
        const source = fs.realpathSync(input)
        if (source.split(path.sep).some((part) => EXCLUDED.test(part))) throw new Error('Hidden, credential, and generated directories cannot be attached.')
        if (protectedRoots().some((root) => { const relative = path.relative((fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root)), source); const ancestor = path.relative(source, (fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root))); return (!relative.startsWith('..') && !path.isAbsolute(relative)) || (!ancestor.startsWith('..') && !path.isAbsolute(ancestor)) })) throw new Error('App and CLI private files cannot be attached.')
        const stat = fs.lstatSync(source)
        const name = safeName(path.basename(source))
        const files: StoredFile[] = []
        let skipped = 0
        let visited = 0
        const root = stat.isDirectory() ? source : path.dirname(source)
        const rootBoundary = captureOwnedDirectory(root, root)
        const visit = (candidate: string, relative: string): void => {
          if (++visited > 2000) throw new Error('Folder contains too many entries. Select a smaller reference folder.')
          assertOwnedDirectoryBoundary(rootBoundary)
          const leaf = path.basename(candidate)
          if (EXCLUDED.test(leaf)) { skipped++; return }
          const current = fs.lstatSync(candidate)
          if (current.isSymbolicLink()) { skipped++; return }
          if (current.isDirectory()) {
            const directory = captureOwnedDirectory(root, candidate)
            const entries = boundedOwnedDirectoryEntries(directory, 2000 - visited || 1)
            if (entries.truncated) throw new Error('Folder contains too many entries.')
            for (const entry of entries.entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) visit(path.join(candidate, entry.name), relative ? `${relative}/${entry.name}` : entry.name)
          } else if (current.isFile() && ALLOWED.test(leaf)) {
            if (totalFiles + 1 > MAX_CONTEXT_FILES || current.size > MAX_CONTEXT_FILE_BYTES || totalBytes + current.size > MAX_CONTEXT_BYTES) throw new Error('Context is limited to 100 files, 20 MB per file, and 100 MB total.')
            const content = readOwnedFile(captureOwnedDirectory(root, path.dirname(candidate)), leaf, MAX_CONTEXT_FILE_BYTES, 'Attachment')
            assertOwnedDirectoryBoundary(rootBoundary)
            if (totalBytes + content.length > MAX_CONTEXT_BYTES) throw new Error('Context exceeds the 100 MB limit.')
            totalBytes += content.length; totalFiles++
            files.push({ name: safeName(relative || leaf), bytes: content })
          } else skipped++
        }
        if (stat.isDirectory()) visit(source, '')
        else visit(source, name)
        if (!files.length) throw new Error('No supported reference files found. Choose images, documents, media, or source files.')
        const item: BuildAttachment = { id: crypto.randomUUID(), name, kind: stat.isDirectory() ? 'folder' : IMAGE_MIMES[path.extname(name).toLowerCase()] ? 'image' : 'file', bytes: files.reduce((sum, file) => sum + file.bytes.length, 0), files: files.length, skipped }
        added.push({ item, files, source, dev: stat.dev, ino: stat.ino })
      }
      for (const entry of added) stored.set(entry.item.id, entry)
      return added.map((entry) => entry.item)
    },
    remove(value: unknown): void { const entry = get(value); stored.delete(entry.item.id) },
    preview(value: unknown): string {
      const entry = get(value)
      if (entry.item.kind !== 'image') throw new Error('This attachment is not a previewable image.')
      return `data:${IMAGE_MIMES[path.extname(entry.item.name).toLowerCase()]};base64,${entry.files[0].bytes.toString('base64')}`
    },
    folder(value: unknown): string {
      const entry = get(value)
      if (entry.item.kind !== 'folder') throw new Error('This attachment is not a folder.')
      const stat = fs.lstatSync(entry.source)
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(entry.source) !== entry.source || stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error('The original folder moved or changed. Add it again.')
      return entry.source
    },
    snapshot(value: unknown): { sourceId: string; name: string; bytes: Buffer }[] {
      return ids(value).map(get).flatMap(entry => entry.files.map(file => ({ sourceId: entry.item.id, name: file.name, bytes: file.bytes })))
    },
    prepare(value: unknown): PreparedContext | null {
      const selected = ids(value).map(get)
      if (!selected.length) return null
      return { publish(workspace, referenceDir) {
        if (!/^reference\/[a-zA-Z0-9-]+$/.test(referenceDir)) throw new Error('Invalid reference directory.')
        let boundary = captureOwnedDirectory(workspace, workspace)
        for (const segment of [...referenceDir.split('/'), 'supplied']) {
          assertOwnedDirectoryBoundary(boundary)
          const next = path.join(boundary.path, segment)
          if (segment === 'supplied') fs.mkdirSync(next, { mode: 0o700 })
          else if (!fs.existsSync(next)) fs.mkdirSync(next, { mode: 0o700 })
          boundary = captureOwnedDirectory(workspace, next)
        }
        const manifest: Array<{ file: string; attachment: string; original: string; bytes: number; sha256: string }> = []
        for (const entry of selected) for (const source of entry.files) {
          const leaf = path.basename(source.name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100)
          const file = `${String(manifest.length + 1).padStart(3, '0')}-${leaf}`
          assertOwnedDirectoryBoundary(boundary)
          fs.writeFileSync(path.join(boundary.path, file), source.bytes, { flag: 'wx', mode: 0o600 })
          assertOwnedDirectoryBoundary(boundary)
          manifest.push({ file, attachment: entry.item.name, original: source.name, bytes: source.bytes.length, sha256: crypto.createHash('sha256').update(source.bytes).digest('hex') })
        }
        fs.writeFileSync(path.join(boundary.path, 'manifest.json'), JSON.stringify({ version: 1, files: manifest }, null, 2), { flag: 'wx', mode: 0o600 })
        assertOwnedDirectoryBoundary(boundary)
        return { fingerprint: referencePackFingerprint(workspace, `${referenceDir}/supplied`), files: manifest.length, bytes: manifest.reduce((sum, file) => sum + file.bytes, 0), paths: manifest.map((file) => `${referenceDir}/supplied/${file.file}`) }
      } }
    },
  }
}
