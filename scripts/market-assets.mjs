import { statSync } from 'node:fs'
import { extname } from 'node:path'
import { assertMediaPaths, localFile, MAX_README_BYTES } from './plugin-contract.mjs'

export function markdownImagePaths(text) {
  return [...text.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)].map(match => match[1] || match[2])
}

/** Pass public/ for source validation, the distribution root for release metadata. */
export function resolveMarketAssets(manifest, assetRoot, { release = true } = {}) {
  assertMediaPaths(manifest)
  if (statSync(localFile(assetRoot, manifest.market.readme)).size > MAX_README_BYTES) throw new Error(`${manifest.id}: README exceeds 512 KiB`)
  const screenshots = manifest.market.screenshots
  if (!Array.isArray(screenshots) || screenshots.length > 8 || new Set(screenshots).size !== screenshots.length || (release && !screenshots.length)) throw new Error(`${manifest.id}: release requires 1–8 unique screenshots`)
  const resource = (path, suffix) => ({ source: localFile(assetRoot, path), url: ['plugins', manifest.id, 'dist', ...path.split('/')].map(encodeURIComponent).join('/'), releaseName: `${manifest.id}@${manifest.version}-${suffix}${extname(path)}` })
  return {
    icon: resource(manifest.icon, 'icon'),
    readme: resource(manifest.market.readme, 'README'),
    screenshots: release ? screenshots.map((path, index) => resource(path, `screenshot-${index + 1}`)) : []
  }
}
