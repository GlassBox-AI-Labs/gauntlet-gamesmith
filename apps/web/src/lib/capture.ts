export function captureServerError(error: unknown, context: string) {
  console.error(
    JSON.stringify({
      context,
      error: error instanceof Error ? error.name : 'BackendError',
    }),
  )
}
export function captureClientError(error: unknown, context: string) {
  console.error(
    JSON.stringify({
      context,
      error: error instanceof Error ? error.name : 'ClientError',
    }),
  )
}
