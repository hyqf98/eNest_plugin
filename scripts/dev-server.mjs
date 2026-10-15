import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot, pluginIds, localFile } from './plugin-contract.mjs'
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }
export const productionCsp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'"
export async function createPreviewServer(port = 0, { root = repositoryRoot } = {}) {
  const ids = new Set(pluginIds(root))
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost'), match = /^\/plugins\/([^/]+)\/(.*)$/.exec(decodeURIComponent(url.pathname))
      if (!match || !ids.has(match[1])) { response.writeHead(404); response.end(); return }
      if (match[2] && match[2] !== 'index.html' && !match[2].startsWith('assets/')) { response.writeHead(404); response.end(); return }
      const file = localFile(join(root, 'plugins', match[1], 'dist'), match[2] || 'index.html')
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Security-Policy': productionCsp })
      response.end(await readFile(file))
    } catch { response.writeHead(404); response.end('Not found') }
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log('Production plugin preview: ' + (await createPreviewServer(Number(process.env.PORT || 4178))).url)
