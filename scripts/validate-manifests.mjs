#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync, lstatSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { repositoryRoot as root, pluginIds, assertMediaPaths, localFile, readManifest, pluginHtmlEntries } from './plugin-contract.mjs'
import { resolveMarketAssets } from './market-assets.mjs'
import { homeContributionErrors, mcpContributionErrors } from '../packages/plugin-sdk/src/validate.mjs'

export function loadManifestValidator() {
  return new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(join(root, 'docs/plugin-manifest.schema.json'), 'utf8')))
}
export function validateManifest(validator, manifest, label) {
  return validator(manifest) ? [...homeContributionErrors(manifest), ...mcpContributionErrors(manifest)].map(error => `${label}: ${error}`) : validator.errors.map(error => `${label}: ${error.instancePath || '(root)'} ${error.message}`)
}
export function validateSource(directory, { release = true } = {}) {
  const errors = []
  try {
    localFile(directory, 'plugin.json')
    const manifest = readManifest(directory)
    errors.push(...validateManifest(loadManifestValidator(), manifest, manifest.id))
    if (errors.length) return errors
    assertMediaPaths(manifest)
    for (const entry of pluginHtmlEntries(manifest)) localFile(directory, entry)
    const pkg = JSON.parse(readFileSync(localFile(directory, 'package.json'), 'utf8'))
    if (pkg.name !== manifest.id.split('.').pop() || pkg.version !== manifest.version || pkg.type !== 'module') throw new Error('package.json name (id 末段)/version/type must match plugin.json')
    if (['icon.svg', 'icon.png', 'logo.png', 'README.md', 'settings.html', 'runtime', 'shared'].some(name => existsSync(join(directory, name)))) throw new Error('Legacy root assets/icon/README/runtime are not allowed')
    // Declared Vite HTML inputs may live under assets/. Static media still has one
    // canonical source in public/assets; this does not restore legacy asset roots.
    if (existsSync(join(directory, 'assets'))) {
      const entries = new Set(pluginHtmlEntries(manifest))
      const inspectInput = path => {
        const stat = lstatSync(join(directory, path))
        if (stat.isSymbolicLink()) throw new Error(`Symlink forbidden: ${path}`)
        if (stat.isDirectory() && [...entries].some(entry => entry.startsWith(`${path}/`))) {
          for (const name of readdirSync(join(directory, path))) inspectInput(`${path}/${name}`)
        } else if (!stat.isFile() || !entries.has(path)) throw new Error(`Undeclared root asset: ${path}`)
      }
      inspectInput('assets')
    }
    const publicRoot = join(directory, 'public')
    if (readdirSync(publicRoot).some(name => name !== 'assets')) throw new Error('public may only contain assets/')
    if (readdirSync(join(publicRoot, 'assets')).some(name => !['market', 'vendor'].includes(name))) throw new Error('public/assets may only contain market/ and vendor/')
    const inspect = path => {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`Symlink forbidden: ${relative(directory, path)}`)
      if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name))
    }
    inspect(publicRoot)
    for (const name of ['src', 'tests', 'backend']) if (existsSync(join(directory, name))) inspect(join(directory, name))
    if (manifest.backend) {
      if (!pkg.enestBackend?.entry || !Array.isArray(pkg.enestBackend.dependencies)) throw new Error('Declared backend requires package.enestBackend build config')
      localFile(directory, pkg.enestBackend.entry)
    }
    if (pkg.enestBuild !== undefined) {
      if (!pkg.enestBuild || typeof pkg.enestBuild !== 'object' || Array.isArray(pkg.enestBuild) || typeof pkg.enestBuild.entry !== 'string') throw new Error('enestBuild requires a plugin-local entry')
      localFile(directory, pkg.enestBuild.entry)
    }
    resolveMarketAssets(manifest, publicRoot, { release })
    if (manifest.development?.main) {
      const url = new URL(manifest.development.main)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('development.main must be an HTTP(S) URL without credentials or fragment')
    }
  } catch (error) { errors.push(`${directory}: ${error.message}`) }
  return errors
}
export function validateAllManifests(repositoryRoot = root) {
  return pluginIds(repositoryRoot).flatMap(id => {
    const directory = join(repositoryRoot, 'plugins', id), manifest = readManifest(directory)
    return [...(manifest.id.split('.').pop() === id ? [] : [`${id}: id 末段必须等于目录名`]), ...validateSource(directory)]
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = validateAllManifests()
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log('[validate-manifests] all source projects valid')
}
