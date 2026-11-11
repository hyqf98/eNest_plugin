#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot as root } from './plugin-contract.mjs'
import { buildRegistry, archiveMetadata, SOURCE_BASE } from './build-registry.mjs'
import { markdownImagePaths } from './market-assets.mjs'
import { PLATFORM_TARGETS } from './distribution-target.mjs'

/**
 * 市场门面（icon/截图/README 及其内嵌图）以仓库 main 分支的 public 资产为
 * 单一事实源；Release 只承载不可变的 .enestplugin 包、DSH 运行时与索引。
 * 仅包下载地址（asset.url）指向 Release，媒体一律引用仓库源码。
 */
export function prepareRelease({ repositoryRoot = root, repository, tag, outDir = join(repositoryRoot, 'dist') }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !tag) throw new Error('REPO and TAG are required')
  const registry = buildRegistry(repositoryRoot, { outDir })
  const base = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/`
  const readmeImages = (plugin, target = 'universal') => {
    const { manifest, entries } = archiveMetadata(readFileSync(join(outDir, plugin.asset.name)), plugin, { target })
    const sourceUrl = path => `${SOURCE_BASE}plugins/${plugin.id.split('.').pop()}/public/${path.split('/').map(encodeURIComponent).join('/')}`
    const images = {}
    const markdown = new TextDecoder().decode(entries[manifest.market.readme])
    for (const relative of markdownImagePaths(markdown)) {
      const path = posix.normalize(posix.join(posix.dirname(manifest.market.readme), relative))
      if (!path.startsWith('assets/market/') || !entries[path] || !/\.(png|webp|jpe?g)$/i.test(path)) throw new Error(`Invalid README image: ${relative}`)
      const screenshotIndex = manifest.market.screenshots.indexOf(path)
      images[relative] = screenshotIndex >= 0 ? plugin.screenshots[screenshotIndex] : sourceUrl(path)
    }
    return images
  }
  for (const plugin of registry.plugins) {
    plugin.asset.url = base + encodeURIComponent(plugin.asset.name)
    plugin.readmeImages = readmeImages(plugin)
  }
  // 每插件单一 universal 包：不再生成平台变体 registry-<target>.json。
  for (const target of PLATFORM_TARGETS) rmSync(join(outDir, `registry-${target}.json`), { force: true })
  mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, 'registry.json'), JSON.stringify(registry, null, 2) + '\n')
  return registry
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`[release] prepared ${prepareRelease({ repository: process.env.REPO, tag: process.env.TAG }).plugins.length} plugins`)
