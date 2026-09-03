import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { developmentAppIconPath } from './development-app-icon'

describe('developmentAppIconPath', () => {
  it('wires the committed application icon into development only', () => {
    const appPath = path.resolve(__dirname, '../..')
    expect(developmentAppIconPath(appPath, false)).toBe(path.join(appPath, 'build', 'icon.png'))
    expect(developmentAppIconPath(appPath, true)).toBeNull()
  })
})
