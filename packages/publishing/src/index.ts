/** Wire contract only: safe to import from browsers, Electron shared code, and Node. */
export const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024
export const MAX_WIRE_BYTES = 35 * 1024 * 1024
export const MAX_FILES = 1500
export interface ArtifactFile { path: string; data: string; sha256: string }
export interface GameArtifact { version: 1; sourceRevision: string; files: ArtifactFile[] }
export interface Listing { title: string; slug: string; description: string; controls: string; coverPath: string | null }
export const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json', wasm: 'application/wasm',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  svg: 'image/svg+xml', ico: 'image/x-icon', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
  mp4: 'video/mp4', webm: 'video/webm', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  bin: 'application/octet-stream', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', txt: 'text/plain',
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.')
  return value as Record<string, unknown>
}
export function boundedText(value: unknown, name: string, max: number, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u0008]/.test(value)) throw new Error(`Invalid ${name}.`)
  return value.trim()
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid identifier.')
  return value
}
export function assetPath(value: unknown): string {
  const file = boundedText(value, 'asset path', 240)
  if (!/^[a-zA-Z0-9_/-][a-zA-Z0-9_. /-]*$/.test(file) || file.startsWith('/') || file.split('/').some(p => !p || p.startsWith('.') || /^(node_modules|reference|critique|coverage)$/i.test(p)) || !MIME[file.split('.').at(-1)!.toLowerCase()]) throw new Error(`Unsupported asset path: ${file}`)
  return file
}
export function listing(value: unknown): Listing {
  const v = object(value)
  const slug = boundedText(v.slug, 'slug', 64)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Use lowercase letters, numbers, and single hyphens for the URL.')
  const coverPath = v.coverPath == null || v.coverPath === '' ? null : assetPath(v.coverPath)
  if (coverPath && !/\.(png|jpe?g|webp|gif)$/i.test(coverPath)) throw new Error('Cover must be PNG, JPEG, WebP, or GIF.')
  return { title: boundedText(v.title, 'title', 80), slug, description: boundedText(v.description, 'description', 2000), controls: boundedText(v.controls ?? '', 'controls', 500, 0), coverPath }
}
