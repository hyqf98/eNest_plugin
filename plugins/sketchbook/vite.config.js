import { defineConfig } from 'vite'

/**
 * 只用于本地调试的 dev server：插件本身是零构建的纯 ESM + CSS，
 * 主题工作区页面在宿主 dev 源码态是磁盘直读的，不走这里。
 * 这里只是让浏览器能直接打开 index.html / homes/*.html 看样式。
 */
export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: { host: '127.0.0.1', port: 5210, strictPort: true },
})
