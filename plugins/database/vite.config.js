import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { generateExecutionParser } from './scripts/generate-execution-parser.mjs'

/** 保留 @db alias；JSX automatic 与 build-plugin.mjs 注入保持一致（dev/build 等价） */
export default defineConfig({
  plugins: [{
    name: 'database-execution-parser',
    configResolved() { generateExecutionParser() },
  }],
  resolve: { alias: { '@db': fileURLToPath(new URL('./src/js', import.meta.url)) } },
  esbuild: { jsx: 'automatic' },
})
