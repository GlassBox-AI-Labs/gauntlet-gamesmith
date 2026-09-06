import type { OperationResult } from './result'
export interface PublishDraft { loopId: string; round: number; title: string; slug: string; description: string; controls: string; coverPath: string; outputDir: string }
export interface PublicationPreview { releaseId: string; gameId: string; generation: number; gameUrl: string; previewUrl: string }
export interface PublisherStatus { connected: boolean; catalogUrl: string; publisherName: string | null }
export interface PublishingApi {
  status(): Promise<OperationResult<PublisherStatus>>
  signIn(): Promise<OperationResult<PublisherStatus>>
  cancelSignIn(): Promise<OperationResult<void>>
  signOut(): Promise<OperationResult<void>>
  prepare(input: PublishDraft): Promise<OperationResult<PublicationPreview>>
  publish(input: { loopId: string; releaseId: string; gameId: string; generation: number }): Promise<OperationResult<string>>
}
