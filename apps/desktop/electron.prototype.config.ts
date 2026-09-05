import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
export default defineConfig({
  main: { build: { outDir: 'out/prototype/main', rollupOptions: { input: { index: path.resolve(__dirname, 'src/main/prototype-entry.ts') } } } },
  preload: { build: { outDir: 'out/prototype/preload', rollupOptions: { input: { index: path.resolve(__dirname, 'src/preload/prototype.ts') } } } },
  renderer: {
    plugins: [react(), tailwindcss()],
    server: { host: '127.0.0.1', port: Number(process.env.CONDUCTOR_PORT || 5176), strictPort: true },
    resolve: { alias: { '@': path.resolve(__dirname, 'src/renderer/src') } },
  },
})
