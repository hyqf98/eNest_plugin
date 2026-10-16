import { defineConfig } from 'vite'

/** 官方插件统一 React 技术栈：dev 与 build-plugin.mjs 注入保持一致的 JSX automatic 转换 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
})
