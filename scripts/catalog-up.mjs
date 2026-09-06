import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
execFileSync(process.execPath, ['scripts/catalog-db.mjs'], { cwd, stdio: 'inherit' })
execFileSync('pnpm', ['--filter', '@gauntlet/web', 'build'], { cwd, stdio: 'inherit' })
const child = spawn('pnpm', ['--filter', '@gauntlet/web', 'start'], { cwd, stdio: 'inherit' })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
process.on('SIGINT', () => child.kill('SIGINT'))
