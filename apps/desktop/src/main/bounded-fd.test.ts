import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readExactFileDescriptor } from './bounded-fd'

let dir: string | null = null

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('readExactFileDescriptor', () => {
  it('does not follow concurrent growth beyond the validated snapshot', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-bounded-fd-'))
    const file = path.join(dir, 'growing')
    fs.writeFileSync(file, 'safe')
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      fs.appendFileSync(file, '-unbounded-tail')
      expect(readExactFileDescriptor(fd, size, size, 'test file').toString('utf8')).toBe('safe')
    } finally {
      fs.closeSync(fd)
    }
  })

  it('rejects an invalid size before allocation', () => {
    expect(() => readExactFileDescriptor(-1, 1025, 1024, 'test file')).toThrow(/bounded read limit/)
  })
})
