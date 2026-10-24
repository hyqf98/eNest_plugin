#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { unzipSync, strFromU8 } from 'fflate'
import { repositoryRoot as root, pluginIds, readManifest, assertMediaPaths, validPath, validBackendPath, pluginHtmlEntries, MAX_README_BYTES } from './plugin-contract.mjs'
import { loadManifestValidator, validateManifest } from './validate-manifests.mjs'
import { BACKEND_INVENTORY_FILE, DISTRIBUTION_TARGET_FILE, normalizeTarget, platformPackagePlan, resolveDistributionTarget } from './distribution-target.mjs'

const DEFAULT_SOURCE_BASE = 'https://raw.githubusercontent.com/hyqf98/eNest_plugin/main/'

/** Only final ZIP bytes supply registry metadata and media. Source identifies the version to publish. */
export function archiveMetadata(archive, expected, { target = 'universal' } = {}) {
  normalizeTarget(target)
  const names = new Set()
  let hasRuntime = false
  const backendPaths = new Set()
  const homeCandidates = []
  const entries = unzipSync(new Uint8Array(archive), { filter: file => {
    const path = file.name.replace(/\/$/, '')
    if (names.has(file.name)) throw new Error(`Duplicate archive entry: ${file.name}`)
    names.add(file.name)
    if (path === 'backend' || path.startsWith('backend/')) {
      if (!validBackendPath(path) || /\.(map|tsx?|vue)$/i.test(path)) throw new Error(`Invalid backend archive entry: ${file.name}`)
      backendPaths.add(path)
      if (path === BACKEND_INVENTORY_FILE && file.originalSize > 2 * 1024 * 1024) throw new Error('Backend inventory exceeds 2 MiB')
      return path === BACKEND_INVENTORY_FILE
    }
    if (path.startsWith('runtime/') || path === 'runtime') {
      if (/[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid runtime archive entry: ${file.name}`)
      hasRuntime = true; return false
    }
    if (!validPath(path)) throw new Error(`Invalid archive entry: ${file.name}`)
    if (!['plugin.json', 'index.html', 'assets'].includes(path.split('/')[0])) homeCandidates.push({ path, directory: file.name.endsWith('/') })
    if (path.split('/').some(part => ['src', 'tests', 'node_modules'].includes(part)) || /\.(map|tsx?|vue)$/i.test(path)) throw new Error(`Development file in archive: ${file.name}`)
    if (path === 'assets/market/README.md' && file.originalSize > MAX_README_BYTES) throw new Error('README exceeds 512 KiB')
    if (path === DISTRIBUTION_TARGET_FILE && file.originalSize > 4096) throw new Error('Distribution target metadata exceeds 4 KiB')
    return file.name === 'plugin.json' || path === DISTRIBUTION_TARGET_FILE || (!file.name.endsWith('/') && file.name.startsWith('assets/market/'))
  } })
  if (!names.has('index.html')) throw new Error('Archive has no index.html')
  if (!entries['plugin.json']) throw new Error('Archive has no plugin.json')
  const manifest = JSON.parse(strFromU8(entries['plugin.json']))
  const errors = validateManifest(loadManifestValidator(), manifest, manifest.id)
  if (errors.length) throw new Error(errors.join('\n'))
  const homeEntries = new Set(pluginHtmlEntries(manifest))
  for (const candidate of homeCandidates) {
    if (!homeEntries.has(candidate.path) && !(candidate.directory && [...homeEntries].some(entry => entry.startsWith(`${candidate.path}/`)))) {
      throw new Error(`Invalid archive entry: ${candidate.path}`)
    }
  }
  for (const entry of homeEntries) if (!names.has(entry)) throw new Error(`Declared home entry missing from archive: ${entry}`)
  assertMediaPaths(manifest)
  if (hasRuntime && !manifest.backend) throw new Error('Private runtime requires a declared plugin backend')
  if (backendPaths.size && !manifest.backend) throw new Error('Undeclared plugin backend')
  if (manifest.backend && !backendPaths.has(manifest.backend.entry)) throw new Error('Plugin backend entry missing from archive')
  if (manifest.development) throw new Error('Archive contains development configuration')
  const metadata = entries[DISTRIBUTION_TARGET_FILE] ? JSON.parse(strFromU8(entries[DISTRIBUTION_TARGET_FILE])) : undefined
  const inventory = entries[BACKEND_INVENTORY_FILE] ? JSON.parse(strFromU8(entries[BACKEND_INVENTORY_FILE])) : undefined
  const archiveTarget = resolveDistributionTarget(metadata, inventory)
  if (archiveTarget !== target) throw new Error(`Archive target ${archiveTarget} cannot be published as ${target}`)
  for (const native of inventory?.nativePackages || []) {
    if (!validBackendPath(native.path) || !backendPaths.has(`backend/${native.path}/package.json`)) throw new Error('Native inventory references a missing package')
  }
  if (expected && (manifest.id !== expected.id || manifest.version !== expected.version)) throw new Error('Archive identity/version does not match source')
  const media = [manifest.icon, manifest.market.readme, ...manifest.market.screenshots]
  if (!manifest.market.screenshots.length || media.some(path => !entries[path])) throw new Error('Archive is missing required market resources')
  return { manifest, entries, target: archiveTarget }
}

export function buildRegistry(repositoryRoot = root, { outDir = join(repositoryRoot, 'dist'), baseUrl = DEFAULT_SOURCE_BASE, target = 'universal' } = {}) {
  normalizeTarget(target)
  mkdirSync(outDir, { recursive: true })
  const plugins = pluginIds(repositoryRoot).map(id => {
    const source = join(repositoryRoot, 'plugins', id), expected = readManifest(source)
    if (target !== 'universal') platformPackagePlan(source, { root: repositoryRoot, target })
    const variant = `${id}@${expected.version}-${target}.enestplugin`
    const selectedTarget = target !== 'universal' && existsSync(join(outDir, variant)) ? target : 'universal'
    const name = selectedTarget === 'universal' ? `${id}@${expected.version}.enestplugin` : variant
    const archive = readFileSync(join(outDir, name)), { manifest: m, entries } = archiveMetadata(archive, expected, { target: selectedTarget })
    const publish = path => {
      const shortId = id.split('.').pop()
      const relative = `plugins/${shortId}/public/${path}`
      const target = join(outDir, `${id}@${m.version}`, path)
      mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, entries[path])
      return baseUrl + relative.split('/').map(encodeURIComponent).join('/')
    }
    // All images referenced by the packaged README keep their relative layout.
    for (const path of Object.keys(entries)) if (path.startsWith('assets/market/')) publish(path)
    return {
      id: m.id, name: m.name, version: m.version, description: m.description, author: m.author ?? '', category: m.category ?? '其它',
      icon: publish(m.icon), readmeUrl: publish(m.market.readme), screenshots: m.market.screenshots.map(publish), tags: m.market.tags ?? [],
      permissions: m.permissions ?? [], engines: m.engines ?? {}, featured: m.market.featured ?? false, ui: m.ui ?? {},
      asset: { name, url: baseUrl + encodeURIComponent(name), size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }
    }
  })
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), channel: process.env.CHANNEL || 'stable', categories: ['效率', '开发', '设计', '媒体', '其它'], plugins }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = normalizeTarget(process.argv.slice(2).find(value => value.startsWith('--target='))?.slice('--target='.length))
  const registry = buildRegistry(root, { target }), path = join(root, 'dist', target === 'universal' ? 'registry.json' : `registry-${target}.json`)
  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n')
  console.log(`[registry] ${registry.plugins.length} archives → ${path}`)
}
