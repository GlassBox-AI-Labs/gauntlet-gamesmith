const ENROLLMENT_ROUTES = new Set([
  'signup',
  'verify-email',
  'resend-verification',
])

/** Network failures have no API response; keep account data out of diagnostics. */
export async function requestCatalog(
  catalogUrl: string,
  route: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(`${catalogUrl}/api/${route}`, init)
  } catch {
    if (init.signal?.aborted) {
      if (init.signal.reason?.name === 'TimeoutError')
        throw new Error('The publishing service took too long to respond. Please try again.')
      throw new Error('Publishing request cancelled.')
    }
    const endpoint = new URL(catalogUrl)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    throw new Error(
      `Cannot reach the publishing service at ${endpoint.origin}. ` +
      (local
        ? 'Start the local catalog, or restart the app with the hosted publishing service.'
        : 'Check your internet connection and try again.'),
    )
  }
  return readCatalogResponse(response, route)
}

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
