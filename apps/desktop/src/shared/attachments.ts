export interface BuildAttachment {
  id: string
  name: string
  kind: 'image' | 'file' | 'folder'
  bytes: number
  files: number
  skipped: number
}
export type AttachmentResult<T> = { ok: true; value: T } | { ok: false; error: string }
export interface AttachmentApi {
  addFiles(files: File[]): Promise<AttachmentResult<BuildAttachment[]>>
  pick(): Promise<AttachmentResult<BuildAttachment[]>>
  preview(id: string): Promise<AttachmentResult<string>>
  openFolder(id: string): Promise<AttachmentResult<null>>
  remove(id: string): Promise<AttachmentResult<null>>
}
export const MAX_CONTEXT_FILES = 100
export const MAX_CONTEXT_BYTES = 100 * 1024 * 1024
export const MAX_CONTEXT_FILE_BYTES = 20 * 1024 * 1024
