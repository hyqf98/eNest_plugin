#!/usr/bin/env node
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot as root } from './plugin-contract.mjs'
import { buildRegistry } from './build-registry.mjs'
import { PLATFORM_TARGETS } from './distribution-target.mjs'

/**
 * 市场门面（icon/截图/README 及其内嵌图）以仓库 main 分支的 public 资产为
 * 单一事实源；Release 只承载不可变的 .enestplugin 包与索引。
 * 仅包下载地址（asset.url）指向 Release，媒体一律引用仓库源码。
 */
export function prepareRelease({ repositoryRoot = root, repository, tag, outDir = join(repositoryRoot, 'dist') }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !tag) throw new Error('REPO and TAG are required')
  const packageBaseUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/`
  const registry = buildRegistry(repositoryRoot, { outDir, packageBaseUrl })
  const universalPlugins = new Map(registry.plugins.map(plugin => [plugin.id, plugin]))
  for (const target of PLATFORM_TARGETS) {
    const file = join(outDir, `registry-${target}.json`)
    if (!registry.plugins.some(plugin => existsSync(join(outDir, plugin.asset.name.replace(/\.enestplugin$/, `-${target}.enestplugin`))))) {
      rmSync(file, { force: true })
      continue
    }
    const variant = buildRegistry(repositoryRoot, { outDir, packageBaseUrl, target, universalPlugins })
    writeFileSync(file, JSON.stringify(variant, null, 2) + '\n')
  }
  writeFileSync(join(outDir, 'registry.json'), JSON.stringify(registry, null, 2) + '\n')
  return registry
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`[release] prepared ${prepareRelease({ repository: process.env.REPO, tag: process.env.TAG }).plugins.length} plugins`)
