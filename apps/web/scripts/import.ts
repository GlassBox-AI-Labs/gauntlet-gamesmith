import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { packDirectory } from '@gauntlet/publishing/node'
const [directory, output, revision = 'developer-import'] = process.argv.slice(2)
if (!directory || !output) throw new Error('Usage: pnpm catalog:import BUILD_DIRECTORY OUTPUT.json [SOURCE_REVISION]')
const artifact = await packDirectory(path.resolve(directory), revision)
await writeFile(path.resolve(output), JSON.stringify(artifact), { flag: 'wx', mode: 0o600 })
console.log(`Packaged ${artifact.files.length} shipping files. Upload ${path.resolve(output)} in Publisher studio.`)
