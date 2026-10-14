#!/usr/bin/env node
import { readdir, readFile, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join, dirname, extname, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { init, parse } from 'es-module-lexer'
import { repositoryRoot, pluginIds, readManifest, localFile, validPath, DSH_ID } from './plugin-contract.mjs'
import { loadManifestValidator, validateManifest } from './validate-manifests.mjs'
import { resolveMarketAssets, markdownImagePaths } from './market-assets.mjs'

export async function validateDistribution(directory, { release = true, requireRuntime = true } = {}) {
  const manifest = readManifest(directory), errors = validateManifest(loadManifestValidator(), manifest, manifest.id)
  if (errors.length) throw new Error(errors.join('\n'))
  if (manifest.development) throw new Error('Published manifest must not contain development')
  resolveMarketAssets(manifest, directory, { release })
  localFile(directory, 'index.html')
  const files = []
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix + entry.name, absolute = join(path, entry.name)
      if ((await lstat(absolute)).isSymbolicLink()) throw new Error(`Symlink forbidden: ${relative}`)
      if (relative === 'runtime' && manifest.id === DSH_ID) continue
      if (relative.split('/').some(part => ['src', 'tests', 'node_modules'].includes(part)) || !validPath(relative) || (!prefix && !['plugin.json', 'index.html', 'assets'].includes(entry.name)) || /\.(map|tsx?|vue)$/i.test(relative)) throw new Error(`File outside distribution contract: ${relative}`)
      if (entry.isDirectory()) await walk(absolute, relative + '/')
      else files.push(relative)
    }
  }
  await walk(directory)
  if (requireRuntime && manifest.id === DSH_ID && !existsSync(join(directory, 'runtime/node_modules/@deepseek-ai/dsh/package.json'))) throw new Error('DSH runtime is missing')
  await init
  function reference(from, value) {
    if (!value || value.startsWith('#') || /^(data:|blob:|https?:|enest:)/.test(value)) return
    const url = value.split(/[?#]/)[0]
    const target = posix.normalize(posix.join(posix.dirname(from), url))
    if (url.startsWith('/') || !validPath(target)) throw new Error(`${from}: non-portable reference ${value}`)
    try { localFile(directory, target) } catch { throw new Error(`${from}: missing local resource ${value}`) }
  }
  for (const file of files) {
    const extension = extname(file)
    if (!['.html', '.js', '.css'].includes(extension)) continue
    const source = await readFile(join(directory, file), 'utf8')
    if (extension === '.html') for (const match of source.matchAll(/<(?:script|link|img|source)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)) reference(file, match[1])
    if (extension === '.css') for (const match of source.matchAll(/url\(\s*["']?([^\s)"']+)["']?\s*\)/g)) reference(file, match[1])
    if (extension === '.js' && !file.includes('/vendor/')) {
      const [imports] = parse(source)
      for (const entry of imports) if (entry.n) reference(file, entry.n)
      for (const match of source.matchAll(/new URL\(["'](\.{1,2}\/[^"']+)["'],\s*import.meta.url\)/g)) reference(file, match[1])
    }
  }
  // README media must resolve within its packaged directory.
  const readme = await readFile(join(directory, manifest.market.readme), 'utf8')
  for (const path of markdownImagePaths(readme)) if (release) reference(manifest.market.readme, path)
  return { id: manifest.id, files: files.length }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const id of pluginIds()) console.log(await validateDistribution(join(repositoryRoot, 'plugins', id, 'dist')))
}
