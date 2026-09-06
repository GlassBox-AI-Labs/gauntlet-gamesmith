export class CatalogError extends Error {
  constructor(
    message: string,
    readonly code:
      'invalid_request' | 'unauthorized' | 'conflict' = 'invalid_request',
  ) {
    super(message)
  }
}
export type Capture = (error: unknown, context: string) => void
export function checked<T>(
  result: { data: T; error: { message: string; code?: string } | null },
  capture: Capture,
  context: string,
): T {
  if (result.error) {
    capture(result.error, context)
    if (result.error.code === 'P0001' || result.error.code === '23505')
      throw new CatalogError(
        'The game changed or this request conflicts with an existing release. Refresh and try again.',
        'conflict',
      )
    throw new Error('Catalog service is unavailable. Please try again.')
  }
  return result.data
}
