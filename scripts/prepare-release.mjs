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
  mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, 'registry.json'), JSON.stringify(registry, null, 2) + '\n')
  for (const target of PLATFORM_TARGETS) {
    rmSync(join(outDir, `registry-${target}.json`), { force: true })
    if (!registry.plugins.some(plugin => existsSync(join(outDir, `${plugin.id.split('.').pop()}@${plugin.version}-${target}.enestplugin`)))) continue
    const variant = buildRegistry(repositoryRoot, { outDir, target })
    for (const plugin of variant.plugins) {
      plugin.asset.url = base + encodeURIComponent(plugin.asset.name)
      // 与 buildRegistry 的选择一致：只有存在平台变体归档的插件才按 target 解析。
      plugin.readmeImages = readmeImages(plugin, plugin.asset.name.endsWith(`-${target}.enestplugin`) ? target : 'universal')
    }
    writeFileSync(join(outDir, `registry-${target}.json`), JSON.stringify(variant, null, 2) + '\n')
  }
  return registry
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`[release] prepared ${prepareRelease({ repository: process.env.REPO, tag: process.env.TAG }).plugins.length} plugins`)
