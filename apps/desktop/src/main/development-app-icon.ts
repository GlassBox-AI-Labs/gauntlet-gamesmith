import fs from 'node:fs'
import path from 'node:path'

/** Packaged icons come from electron-builder; development needs explicit runtime wiring. */
export function developmentAppIconPath(appPath: string, isPackaged: boolean): string | null {
  if (isPackaged) return null
  const candidate = path.join(path.resolve(appPath), 'build', 'icon.png')
  return fs.existsSync(candidate) ? candidate : null
}
