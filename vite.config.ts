import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { salonNeonApiPlugin } from './server/viteApiPlugin.ts'
import { salonOfflinePlugin } from './server/pwaPlugin.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), salonNeonApiPlugin(), salonOfflinePlugin()],
  resolve: {
    alias: {
      cn: path.resolve(__dirname, './src/lib/utils.ts'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
})
