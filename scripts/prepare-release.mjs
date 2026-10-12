#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildRegistry } from './build-registry.mjs'
import { resolveMarketAssets } from './market-assets.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** GitHub Release attachments are flat; every generated media URL must match a filename. */
export function prepareRelease({ repositoryRoot = root, repository, tag, outDir = join(repositoryRoot, 'dist') }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !tag) throw new Error('REPO and TAG are required')
  const registry = buildRegistry(repositoryRoot)
  const base = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/`
  mkdirSync(outDir, { recursive: true })
  const publishImage = (image) => {
    if (!image.source) return image.url
    copyFileSync(image.source, join(outDir, image.releaseName))
    return base + encodeURIComponent(image.releaseName)
  }
  for (const plugin of registry.plugins) {
    const pluginDir = join(repositoryRoot, 'plugins', plugin.id)
    const manifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf-8'))
    const media = resolveMarketAssets(manifest, pluginDir)
    // A missing archive fails the release; never publish an index with empty size/hash.
    const archive = readFileSync(join(outDir, plugin.asset.name))
    plugin.asset.url = base + encodeURIComponent(plugin.asset.name)
    plugin.asset.size = archive.length
    plugin.asset.sha256 = createHash('sha256').update(archive).digest('hex')
    plugin.icon = media.icon ? publishImage(media.icon) : ''
    plugin.screenshots = media.screenshots.map(publishImage)
  }
  writeFileSync(join(outDir, 'registry.json'), JSON.stringify(registry, null, 2) + '\n')
  return registry
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const registry = prepareRelease({ repository: process.env.REPO, tag: process.env.TAG })
  console.log(`[release] prepared ${registry.plugins.length} plugins and media in dist/`)
}
