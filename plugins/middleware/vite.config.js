import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@mw': fileURLToPath(new URL('./src/js', import.meta.url)) } },
  /** 官方插件统一 React 技术栈：dev 与 build-plugin.mjs 注入保持一致的 JSX automatic 转换 */
  esbuild: { jsx: 'automatic' }
})
