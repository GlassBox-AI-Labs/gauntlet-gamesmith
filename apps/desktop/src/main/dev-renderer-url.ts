/** Accept electron-vite's development server only; production always uses bundled assets. */
export function developmentRendererUrl(value: unknown, isPackaged: boolean): string | null {
  if (isPackaged || typeof value !== 'string' || value.length === 0 || value.length > 2_048) return null
  try {
    const url = new URL(value)
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}
