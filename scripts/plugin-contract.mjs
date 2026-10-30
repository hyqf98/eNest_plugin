import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MAX_README_BYTES = 512 * 1024
// Generated from the host policy by api:generate; never maintain a second list here.
export const pluginPermissionPolicy = JSON.parse(readFileSync(join(repositoryRoot, 'docs/plugin-permission-policy.json'), 'utf8'))
export function requiresUserConsent(permission) { return !pluginPermissionPolicy.builtin.includes(permission) }
export function pluginIds(root = repositoryRoot) {
  return readdirSync(join(root, 'plugins'), { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(root, 'plugins', entry.name, 'plugin.json'))).map(entry => entry.name).sort()
}
export function resolvePluginSource(identifier, root = repositoryRoot) {
  if (typeof identifier !== 'string' || !identifier || /[\\/\u0000-\u001f\u007f]/.test(identifier) || identifier === '.' || identifier === '..') throw new Error(`Invalid plugin identifier: ${identifier}`)
  const matches = pluginIds(root).map(slug => {
    const source = join(root, 'plugins', slug)
    return { slug, source, manifest: readManifest(source) }
  }).filter(plugin => plugin.slug === identifier || plugin.manifest.id === identifier)
  if (matches.length === 0) throw new Error(`Unknown plugin: ${identifier}`)
  if (matches.length > 1) throw new Error(`Ambiguous plugin identifier: ${identifier}`)
  return matches[0]
}
export function validPath(value) {
  return typeof value === 'string' && value.length > 0 && !/[:\\?#%\u0000-\u001f\u007f]/.test(value) && !isAbsolute(value) && value.split('/').every(part => part && !part.startsWith('.'))
}
export function validBackendPath(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\\u0000-\u001f\u007f?:*<>|]/.test(value) && value.split('/').every(part => part && !part.startsWith('.'))
}
export function localFile(root, path) {
  if (!validPath(path)) throw new Error(`Invalid package path: ${path}`)
  const base = realpathSync(root), absolute = resolve(base, path)
  let current = base
  for (const part of path.split('/')) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${path}`)
  }
  const delta = relative(base, realpathSync(absolute))
  if (delta.startsWith(`..${sep}`) || isAbsolute(delta) || !lstatSync(absolute).isFile()) throw new Error(`Expected a file inside plugin root: ${path}`)
  return absolute
}
export function readManifest(directory) { return JSON.parse(readFileSync(join(directory, 'plugin.json'), 'utf8')) }
export function pluginHtmlEntries(manifest) {
  return [...new Set(['index.html', ...(manifest.background ? [manifest.background.entry] : []), ...(manifest.contributes?.homePages ?? []).map(home => home.entry),
    ...(manifest.contributes?.themePacks ?? []).flatMap(pack => pack.schemaVersion === 2 ? [
      ...(pack.quick ? [pack.quick.entry] : []),
      ...(pack.settingsPage ? [pack.settingsPage.entry] : []),
      ...['classic', 'rail', 'dock'].flatMap(part => pack.chrome?.[part] ? [pack.chrome[part].entry] : [])
    ] : [])])]
}
export function assertMediaPaths(manifest) {
  if (manifest.main !== 'index.html') throw new Error('main must be index.html')
  if (manifest.icon !== 'assets/market/icon.svg') throw new Error('icon must be assets/market/icon.svg')
  if (manifest.market?.readme !== 'assets/market/README.md') throw new Error('market.readme must be assets/market/README.md')
  for (const path of manifest.market?.screenshots ?? []) {
    if (!validPath(path) || !path.startsWith('assets/market/screenshots/') || !/\.(png|jpe?g|webp)$/i.test(path)) throw new Error(`Invalid screenshot path: ${path}`)
  }
}
