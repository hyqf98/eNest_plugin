import { defineConfig } from 'vite'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('.', import.meta.url))

/** 官方插件统一 React 技术栈：dev 与 build-plugin.mjs 注入保持一致的 JSX automatic 转换 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  build: { copyPublicDir: false },
  plugins: [{
    name: 'image-gen-distribution-assets',
    apply: 'build',
    async writeBundle({ dir }) {
      const publicRoot = join(source, 'public')
      const covers = join(publicRoot, 'assets/vendor/dsh-images-recipes/covers')
      await cp(publicRoot, dir, { recursive: true, filter: path => path !== covers })
      const credits = join(source, 'src/data/recipes')
      const notices = join(dir, 'assets/vendor/dsh-images-recipes')
      for (const name of ['CREDITS.md', 'LICENSE-dsh-images.txt', 'licenses']) {
        await cp(join(credits, name), join(notices, name), { recursive: true })
      }
    },
  }],
})
