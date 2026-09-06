/** Native capabilities for the in-memory build-form prototype. */
export interface ContextFolder { id: string; name: string; path: string }
export type ContextResult<T> = { ok: true; value: T } | { ok: false; error: string }
export interface BuildContextApi {
  droppedFolder(file: File): Promise<ContextResult<ContextFolder | null>>
  pickFolder(): Promise<ContextResult<ContextFolder | null>>
  openFolder(id: string): Promise<ContextResult<null>>
}
