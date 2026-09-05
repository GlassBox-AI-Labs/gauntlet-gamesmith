import { describe, expect, it } from 'vitest'
import { formatPlayExitError, npmPlayArgs } from './play-launch'

describe('formatPlayExitError', () => {
  it('includes the Vite port-in-use message, not only the exit code', () => {
    const error = formatPlayExitError(1, 'error when starting dev server:\nError: Port 5173 is already in use\n')
    expect(error).toContain('code 1')
    expect(error).toContain('Port 5173 is already in use')
  })
})

describe('npmPlayArgs', () => {
  it('turns off strictPort so a busy default port does not kill Play', () => {
    expect(npmPlayArgs('dev', 'vite --host 127.0.0.1 --port 5173')).toEqual([
      'run',
      'dev',
      '--',
      '--strictPort',
      'false',
    ])
  })
})
