import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      // fix-path is ESM-only. Bundle it into the CommonJS main process instead
      // of emitting require("fix-path"), which returns a module namespace.
      externalizeDeps: { exclude: ['fix-path', '@gauntlet/publishing', '@gauntlet/ui'] },
    },
  },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer/src'),
      },
    },
  },
})
