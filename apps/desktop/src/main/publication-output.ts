import fs from 'node:fs/promises'
import path from 'node:path'

const EXCLUDED = new Set(['node_modules', 'reference', 'critique', 'coverage'])
const MAX_ENTRIES = 20_000
type Snapshot = { files: Map<string, string>; entries: string[] }

/** Find the browser output this build produced, without guessing a source directory. */
export async function trackPublicationOutput(
  directory: string,
  log: (text: string) => void,
): Promise<() => Promise<string>> {
  const root = await fs.realpath(directory)
  const identity = await fs.lstat(root)
  async function snapshot(): Promise<Snapshot> {
    const current = await fs.lstat(directory)
    if (
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw new Error('The saved round changed while preparing publication.')
    const files = new Map<string, string>(),
      entries: string[] = []
    let seen = 0
    async function visit(dir: string): Promise<void> {
      const handle = await fs.opendir(dir)
      for await (const entry of handle) {
        if (++seen > MAX_ENTRIES)
          throw new Error(
            'This round has too many files to prepare for publishing.',
          )
        if (
          entry.name.startsWith('.') ||
          EXCLUDED.has(entry.name.toLowerCase())
        )
          continue
        const target = path.join(dir, entry.name),
          stat = await fs.lstat(target, { bigint: true })
        if (stat.isSymbolicLink()) continue
        const canonical = await fs.realpath(target)
        if (!canonical.startsWith(`${root}${path.sep}`))
          throw new Error('Publishing output escaped the saved round.')
        if (stat.isDirectory()) {
          await visit(target)
          continue
        }
        if (!stat.isFile()) continue
        const relative = path.relative(root, target)
        files.set(
          relative,
          `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
        )
        // A source-root index is not an export: never package the project root.
        if (entry.name === 'index.html' && dir !== root && stat.nlink === 1n)
          entries.push(path.relative(root, dir))
      }
    }
    await visit(root)
    return { files, entries }
  }
  const before = await snapshot()
  return async () => {
    const after = await snapshot()
    const changed = [
      ...new Set([...before.files.keys(), ...after.files.keys()]),
    ].filter((file) => before.files.get(file) !== after.files.get(file))
    const candidates = after.entries.filter((dir) =>
      changed.some((file) => file.startsWith(`${dir}${path.sep}`)),
    )
    // Nested index pages belong to the same output, not separate games.
    const roots = candidates.filter(
      (dir) =>
        !candidates.some(
          (parent) => parent !== dir && dir.startsWith(`${parent}${path.sep}`),
        ),
    )
    if (roots.length !== 1) {
      log(
        roots.length
          ? `Publishing found multiple generated browser outputs: ${roots.sort().join(', ')}.`
          : 'Publishing found no generated browser output with index.html outside the source root.',
      )
      throw new Error(
        'This round could not be prepared for publishing. Ask the run to create one publishable browser version, then try again.',
      )
    }
    const output = path.join(root, roots[0]),
      stat = await fs.lstat(output)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(output)) !== output
    )
      throw new Error('Publishing output changed before packaging.')
    log(`Detected shipping output: ${roots[0]}.`)
    return output
  }
}
