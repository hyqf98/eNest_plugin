import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@mw': fileURLToPath(new URL('./src/js', import.meta.url)) } }
})
