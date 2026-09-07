export interface BuildAttachment {
  id: string
  name: string
  kind: 'image' | 'file' | 'folder'
  bytes: number
  files: number
  skipped: number
}
export type AttachmentResult<T> = { ok: true; value: T } | { ok: false; error: string }
export interface AttachmentProgress { files: number; bytes: number }
export interface AttachmentApi {
  onProgress(handler: (progress: AttachmentProgress) => void): () => void
  addFiles(files: File[]): Promise<AttachmentResult<BuildAttachment[]>>
  pick(): Promise<AttachmentResult<BuildAttachment[]>>
  preview(id: string): Promise<AttachmentResult<string>>
  openFolder(id: string): Promise<AttachmentResult<null>>
  remove(id: string): Promise<AttachmentResult<null>>
}
export const MAX_CONTEXT_FILES = 4_000
export const MAX_CONTEXT_BYTES = 1536 * 1024 * 1024
export const MAX_CONTEXT_FILE_BYTES = 1024 * 1024 * 1024
