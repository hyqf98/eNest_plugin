import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/** 保留 @db alias；JSX automatic 与 build-plugin.mjs 注入保持一致（dev/build 等价） */
export default defineConfig({
  resolve: { alias: { '@db': fileURLToPath(new URL('./src/js', import.meta.url)) } },
  esbuild: { jsx: 'automatic' },
})
