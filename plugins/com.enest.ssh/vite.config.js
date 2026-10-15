import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: { alias: { '@ssh': fileURLToPath(new URL('./src', import.meta.url)) } }
})
