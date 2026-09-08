import type { OperationResult } from './result'
export interface PublishDraft {
  buildId: string
  round: number
  title: string
  slug: string
  description?: string
  controls?: string
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
  buildId: string | null
  revision: string | null
}
export interface ReleaseHistory {
  gameId: string | null
  currentReleaseId: string | null
  generation: number
  gameUrl: string | null
  releases: PublishedRelease[]
}
export interface PublisherCredentials {
  email: string
  password: string
}
export interface PublisherSignup extends PublisherCredentials {
  displayName: string
}
export interface PublisherVerification {
  email: string
  code: string
}
export type PublicationTarget = { gameId: string } | { buildId: string }
export interface PublishingApi {
  library(): Promise<OperationResult<PublisherLibrary>>
  onChanged(callback: (kind: 'account' | 'games') => void): () => void
  cover(gameId: string): Promise<OperationResult<string | null>>
  chooseCover(): Promise<OperationResult<CoverSelection | null>>
  updateListing(input: ListingEdit): Promise<OperationResult<void>>
  openGame(gameId: string): Promise<OperationResult<void>>
  history(buildId: string): Promise<OperationResult<ReleaseHistory>>
  previewRelease(
    input: PublicationTarget & { releaseId: string },
  ): Promise<OperationResult<PublicationPreview>>
  unpublish(
    input: PublicationTarget & { generation: number },
  ): Promise<OperationResult<void>>
  status(): Promise<OperationResult<PublisherStatus>>
  signIn(input: PublisherCredentials): Promise<OperationResult<PublisherStatus>>
  signUp(input: PublisherSignup): Promise<OperationResult<void>>
  sendSignInCode(input: { email: string }): Promise<OperationResult<void>>
  verifyEmail(
    input: PublisherVerification,
  ): Promise<OperationResult<PublisherStatus>>
  resendVerification(input: { email: string }): Promise<OperationResult<void>>
  cancelSignIn(): Promise<OperationResult<void>>
  signOut(): Promise<OperationResult<void>>
  prepare(input: PublishDraft): Promise<OperationResult<PublicationPreview>>
  publish(input: {
    buildId?: string
    releaseId: string
    gameId: string
    generation: number
  }): Promise<OperationResult<string>>
}

export interface PublishedGame extends ReleaseHistory {
  gameId: string
  gameUrl: string
  title: string
  description: string
  controls: string
  hasCover: boolean
}
export interface PublisherLibrary {
  status: PublisherStatus
  games: PublishedGame[]
}
export interface CoverSelection {
  id: string
  dataUrl: string
}
export interface ListingEdit {
  gameId: string
  generation: number
  description: string
  controls: string
  coverSelectionId?: string
}
