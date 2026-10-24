import { defineConfig } from 'vite'

/**
 * 工作区保留原生源码直读的纯 ESM + CSS；样式台的 manifest JSON import
 * 需要 Vite 转译。正式包复用本配置构建，本地可直接预览 index.html / homes/*.html。
 */
export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: { host: '127.0.0.1', port: 5210, strictPort: true },
})
