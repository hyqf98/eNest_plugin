import { defineConfig } from 'vite'
import { desktopAssets } from './build/desktop-assets.mjs'

/** 官方插件统一 React 技术栈：dev 与 build-plugin.mjs 注入保持一致的 JSX automatic 转换 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  plugins: [desktopAssets()],
})
