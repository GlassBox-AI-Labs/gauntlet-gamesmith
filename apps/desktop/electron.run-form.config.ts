import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
export default defineConfig({
  main: { build: { outDir: 'out/run-form/main', externalizeDeps: { exclude: ['fix-path', '@gauntlet/publishing', '@gauntlet/ui'] }, rollupOptions: { input: { index: path.resolve(__dirname, 'src/main/index.ts') } } } },
  preload: { build: { outDir: 'out/run-form/preload', rollupOptions: { input: { index: path.resolve(__dirname, 'src/preload/index.ts') } } } },
  renderer: {
    plugins: [react(), tailwindcss()],
    server: { host: '127.0.0.1', port: Number(process.env.CONDUCTOR_PORT || 5177), strictPort: true },
    resolve: { alias: { '@': path.resolve(__dirname, 'src/renderer/src') } },
  },
})
