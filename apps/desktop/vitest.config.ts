import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { multiplayerSdkPlugin } from '../../packages/multiplayer/src/build-plugin'
export default defineConfig({ plugins: [multiplayerSdkPlugin(fileURLToPath(new URL('../../packages/multiplayer/src/browser.ts', import.meta.url)))] })
