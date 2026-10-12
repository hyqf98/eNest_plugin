#!/usr/bin/env node
// Scan manifests and validate media before writing the local registry snapshot.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateAllManifests } from './validate-manifests.mjs'
import { resolveMarketAssets } from './market-assets.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATEGORIES = ['效率', '开发', '设计', '媒体', '其它']

export function buildRegistry(repositoryRoot = root) {
  const errors = validateAllManifests(repositoryRoot)
  if (errors.length) throw new Error(`registry not built:\n${errors.join('\n')}`)
  const pluginsDir = join(repositoryRoot, 'plugins')
  const plugins = []
  for (const dir of existsSync(pluginsDir) ? readdirSync(pluginsDir) : []) {
    const manifestPath = join(pluginsDir, dir, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    const m = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    const media = resolveMarketAssets(m, join(pluginsDir, dir))
    const assetName = `${m.id}@${m.version}.enestplugin`
    plugins.push({
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description ?? '',
      author: m.author ?? '',
      category: m.category ?? '其它',
      icon: media.icon?.url ?? '',
      screenshots: media.screenshots.map((image) => image.url),
      tags: m.market?.tags ?? [],
      permissions: m.permissions ?? [],
      engines: m.engines ?? {},
      featured: m.market?.featured ?? false,
      installs: 0,
      ui: m.ui ?? {},
      asset: { name: assetName, url: assetName, size: 0, sha256: '' }
    })
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    channel: process.env.CHANNEL || 'stable',
    categories: CATEGORIES,
    plugins: plugins.sort((a, b) => a.id.localeCompare(b.id))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const registry = buildRegistry()
  const out = join(root, 'registry.json')
  writeFileSync(out, JSON.stringify(registry, null, 2) + '\n', 'utf-8')
  console.log(`[registry] wrote ${out} (${registry.plugins.length} plugins)`)
}
