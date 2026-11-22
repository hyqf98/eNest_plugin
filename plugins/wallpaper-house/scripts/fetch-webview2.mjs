import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(here)
const nativeDir = join(pluginRoot, 'native', 'windows')
const version = process.env.WEBVIEW2_VERSION || '1.0.2903.40'
const cacheDir = join(nativeDir, '.cache', `webview2-${version}`)
const required = [
  'lib/net462/Microsoft.Web.WebView2.Core.dll',
  'lib/net462/Microsoft.Web.WebView2.WinForms.dll',
  'runtimes/win-x64/native/WebView2Loader.dll',
]

if (required.every(file => existsSync(join(cacheDir, file)))) {
  console.log(`[wallpaper-house] WebView2 SDK ${version} already cached`)
  process.exit(0)
}

console.log(`[wallpaper-house] downloading WebView2 SDK ${version}`)
const response = await fetch(`https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${version}`, { redirect: 'follow' })
if (!response.ok) throw new Error(`WebView2 SDK download failed: HTTP ${response.status}`)
const archive = new Uint8Array(await response.arrayBuffer())
const files = unzipSync(archive)
for (const requiredPath of required) {
  const data = files[requiredPath]
  if (!data) {
    const candidates = Object.keys(files).filter(name => name.includes('WebView2') && name.endsWith('.dll')).slice(0, 20)
    throw new Error(`WebView2 SDK package is missing ${requiredPath}; candidates: ${candidates.join(', ')}`)
  }
  const target = join(cacheDir, requiredPath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, data)
}
console.log(`[wallpaper-house] WebView2 SDK cached at ${cacheDir}`)
