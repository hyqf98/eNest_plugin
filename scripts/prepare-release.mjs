#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, extname, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot as root } from './plugin-contract.mjs'
import { buildRegistry, archiveMetadata } from './build-registry.mjs'
import { markdownImagePaths } from './market-assets.mjs'

/** GitHub attachments are flat; extract the same version's resources from its archive. */
export function prepareRelease({ repositoryRoot = root, repository, tag, outDir = join(repositoryRoot, 'dist') }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !tag) throw new Error('REPO and TAG are required')
  const registry = buildRegistry(repositoryRoot, { outDir })
  const base = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/`
  for (const plugin of registry.plugins) {
    const { manifest, entries } = archiveMetadata(readFileSync(join(outDir, plugin.asset.name)), plugin)
    const publish = (path, suffix) => {
      const filename = `${plugin.id.split('.').pop()}@${plugin.version}-${suffix}${extname(path).toLowerCase()}`
      writeFileSync(join(outDir, filename), entries[path]); return base + encodeURIComponent(filename)
    }
    plugin.icon = publish(manifest.icon, 'icon')
    plugin.screenshots = manifest.market.screenshots.map((path, index) => publish(path, `screenshot-${index + 1}`))
    plugin.readmeUrl = publish(manifest.market.readme, 'README')
    plugin.readmeImages = {}
    const markdown = new TextDecoder().decode(entries[manifest.market.readme])
    let imageIndex = 0
    for (const relative of markdownImagePaths(markdown)) {
      const path = posix.normalize(posix.join(posix.dirname(manifest.market.readme), relative))
      if (!path.startsWith('assets/market/') || !entries[path] || !/\.(png|webp|jpe?g)$/i.test(path)) throw new Error(`Invalid README image: ${relative}`)
      const screenshotIndex = manifest.market.screenshots.indexOf(path)
      plugin.readmeImages[relative] = screenshotIndex >= 0 ? plugin.screenshots[screenshotIndex] : publish(path, `readme-image-${++imageIndex}`)
    }
    plugin.asset.url = base + encodeURIComponent(plugin.asset.name)
  }
  mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, 'registry.json'), JSON.stringify(registry, null, 2) + '\n')
  return registry
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`[release] prepared ${prepareRelease({ repository: process.env.REPO, tag: process.env.TAG }).plugins.length} plugins`)
