import type { OperationResult } from './result'
export interface PublishDraft {
  loopId: string
  round: number
  title: string
  slug: string
  description: string
  controls: string
  coverPath: string
  outputDir: string
}
export interface PublicationPreview {
  releaseId: string
  gameId: string
  generation: number
  gameUrl: string
  previewUrl: string
}
export interface PublisherStatus {
  connected: boolean
  catalogUrl: string
  publisherName: string | null
}
export interface PublishedRelease {
  id: string
  title: string
  status: string
  createdAt: string
  round: number | null
  revision: string | null
}
export interface ReleaseHistory {
  gameId: string | null
  currentReleaseId: string | null
  generation: number
  gameUrl: string | null
  releases: PublishedRelease[]
}
export interface PublishingApi {
  history(loopId: string): Promise<OperationResult<ReleaseHistory>>
  previewRelease(input: {
    loopId: string
    releaseId: string
  }): Promise<OperationResult<PublicationPreview>>
  unpublish(input: {
    loopId: string
    generation: number
  }): Promise<OperationResult<void>>
  status(): Promise<OperationResult<PublisherStatus>>
  signIn(): Promise<OperationResult<PublisherStatus>>
  cancelSignIn(): Promise<OperationResult<void>>
  signOut(): Promise<OperationResult<void>>
  prepare(input: PublishDraft): Promise<OperationResult<PublicationPreview>>
  publish(input: {
    loopId: string
    releaseId: string
    gameId: string
    generation: number
  }): Promise<OperationResult<string>>
}
