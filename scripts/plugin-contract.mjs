import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DSH_DIR = 'dsh'
export const DSH_ID = 'com.github.eNest.dsh'
export const MAX_README_BYTES = 512 * 1024
export const DSH_VERSION = '0.2.0-rc.2'
// Release archives no longer embed the DSH runtime. Users install a published
// dsh-runtime-<version>-<platform>-<arch>.tgz from GitHub Releases on first launch.
// Only pack-dsh-runtime.mjs (and explicit `build-plugin.mjs --runtime`) build it.
export const DSH_BUNDLED_RUNTIME = false
// Generated from the host policy by api:generate; never maintain a second list here.
export const pluginPermissionPolicy = JSON.parse(readFileSync(join(repositoryRoot, 'docs/plugin-permission-policy.json'), 'utf8'))
export function requiresUserConsent(permission) { return !pluginPermissionPolicy.builtin.includes(permission) }
export function pluginIds(root = repositoryRoot) {
  return readdirSync(join(root, 'plugins'), { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(root, 'plugins', entry.name, 'plugin.json'))).map(entry => entry.name).sort()
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
