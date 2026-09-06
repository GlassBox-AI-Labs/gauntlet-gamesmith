const ENROLLMENT_ROUTES = new Set([
  'signup',
  'verify-email',
  'resend-verification',
])

/** Deployment errors may be HTML; never expose their body as an account error. */
export async function readCatalogResponse(
  response: Response,
  route: string,
): Promise<Record<string, unknown>> {
  const fallback =
    ENROLLMENT_ROUTES.has(route) && [404, 405].includes(response.status)
      ? 'Account creation is not available on this publishing server yet. You can still sign in with an existing publisher account.'
      : 'The publishing service could not complete this request. Please try again.'
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .includes('application/json')
  )
    throw new Error(fallback)
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error(fallback)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error(fallback)
  const body = data as Record<string, unknown>
  if (!response.ok)
    throw new Error(
      typeof body.error === 'string' && body.error.length <= 1000
        ? body.error
        : fallback,
    )
  return body
}
