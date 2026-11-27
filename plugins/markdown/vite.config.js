import { defineConfig } from 'vite'

/** 官方插件统一 React 技术栈：dev 与 build-plugin.mjs 注入保持一致的 JSX automatic 转换 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  plugins: [{
    name: 'katex-woff2',
    enforce: 'pre',
    transform(source, id) {
      if (id.endsWith('/katex/dist/katex.min.css')) {
        return source.replace(/(url\((fonts\/KaTeX_[\w-]+)\.woff2\) format\("woff2"\)),url\(\2\.woff\) format\("woff"\),url\(\2\.ttf\) format\("truetype"\)/g, '$1')
      }
    },
  }],
})
