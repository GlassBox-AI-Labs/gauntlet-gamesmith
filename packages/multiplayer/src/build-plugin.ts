import fs from 'node:fs'
import path from 'node:path'
import { buildSync } from 'esbuild'

/** Embed the browser SDK in Electron at build time; generated games need no npm credentials or network install. */
export function multiplayerSdkPlugin(entry: string) {
  let cached: string | undefined
  return {
    name: 'gamesmith-multiplayer-sdk',
    resolveId(id: string) { if (id === 'gamesmith:browser-sdk' || id === 'gamesmith:browser-types') return `\0${id}` },
    load(id: string) {
      if (id === '\0gamesmith:browser-types') return `export default ${JSON.stringify(fs.readFileSync(path.join(path.dirname(entry), 'browser-api.d.ts'), 'utf8'))}`
      if (id !== '\0gamesmith:browser-sdk') return
      cached ??= buildSync({ entryPoints: [entry], bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022', write: false }).outputFiles[0].text
      return `export default ${JSON.stringify(cached)}`
    },
  }
}
