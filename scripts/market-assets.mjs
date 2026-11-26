import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { assertMediaPaths, localFile, MAX_README_BYTES } from './plugin-contract.mjs'
// 由 generate-api-types.mjs 从宿主 src/shared/pluginMarketAssets.ts 生成：两仓用同一套素材标准。
import { pluginIconIssues, pluginScreenshotIssues } from '../packages/plugin-sdk/src/market-assets.mjs'

export function markdownImagePaths(text) {
  return [...text.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)].map(match => match[1] || match[2])
}

/**
 * 图标结构与截图 1200×800 的内容校验；读取的是即将随包发布的真实文件。
 * 图标结构始终校验；截图像素尺寸只在发布时强制——开发构建时截图可能还没定稿，
 * 与「发布必须至少一张截图」是同一条发布边界。
 */
export function assertMarketAssetContent(manifest, assetRoot, { release = true } = {}) {
  const failures = [
    ...pluginIconIssues(readFileSync(localFile(assetRoot, manifest.icon), 'utf8')).map(message => `${manifest.icon}: ${message}`),
    ...(release ? manifest.market.screenshots.flatMap(path => pluginScreenshotIssues(readFileSync(localFile(assetRoot, path)), path).map(issue => `${issue.path}: ${issue.message}`)) : [])
  ]
  if (failures.length) throw new Error(`${manifest.id}: market assets do not meet the standard:\n  - ${failures.join('\n  - ')}`)
}

/** Pass public/ for source validation, the distribution root for release metadata. */
export function resolveMarketAssets(manifest, assetRoot, { release = true } = {}) {
  assertMediaPaths(manifest)
  assertMarketAssetContent(manifest, assetRoot, { release })
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
