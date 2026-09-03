import fs from 'node:fs'

/**
 * Read exactly the already-fstat'd snapshot of a file.
 *
 * `readFileSync(fd)` reads until the current EOF, so an agent appending after
 * the caller's size check can otherwise defeat that allocation bound.
 */
export function readExactFileDescriptor(fd: number, size: number, maximum: number, label: string): Buffer {
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(maximum) || maximum < 0 || size > maximum) {
    throw new Error(`${label} exceeds its bounded read limit.`)
  }
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const count = fs.readSync(fd, bytes, offset, size - offset, offset)
    if (count === 0) break
    offset += count
  }
  if (offset !== size) throw new Error(`${label} shrank during its bounded read.`)
  return bytes
}
