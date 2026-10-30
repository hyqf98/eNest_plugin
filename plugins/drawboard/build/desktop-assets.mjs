import { build } from 'vite'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Compile restricted auxiliary assets without exposing a development server or a plugin bridge. */
export function desktopAssets() {
  let watcher
  return {
    name: 'drawboard-desktop-assets',
    async configResolved(config) {
      const root = config.root, watch = config.command === 'serve'
      const result = await build({ configFile: false, root, publicDir: false, base: './', logLevel: 'warn',
        esbuild: { jsx: 'automatic' },
        plugins: [{ name: 'drawboard-desktop-html', async generateBundle() {
          for (const name of ['canvas', 'tools']) {
            const template = join(root, 'src/desktop', `${name}.html`)
            this.addWatchFile(template)
            this.emitFile({ type: 'asset', fileName: `${name}.html`, source: await readFile(template, 'utf8') })
          }
        } }],
        build: { outDir: join(root, 'public/assets/vendor/drawboard-desktop'), emptyOutDir: true,
          target: 'chrome120', cssCodeSplit: false,
          ...(watch ? { watch: { exclude: ['**/public/**', '**/node_modules/**'] } } : {}),
          rollupOptions: { input: { canvas: join(root, 'src/desktop-canvas.jsx'), tools: join(root, 'src/desktop-tools.jsx') },
            output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js',
              assetFileNames: asset => asset.names?.some(name => name.endsWith('.css')) || asset.name?.endsWith('.css') ? 'desktop.css' : '[name][extname]' } } } })
      if (!watch) return
      watcher = result
      await new Promise((resolve, reject) => {
        const onEvent = event => {
          if (event.code === 'END') { watcher.off('event', onEvent); resolve() }
          else if (event.code === 'ERROR') { watcher.off('event', onEvent); void watcher.close(); reject(event.error) }
        }
        watcher.on('event', onEvent)
      })
    },
    configureServer(server) { server.httpServer?.once('close', () => { void watcher?.close() }) },
  }
}
