import { cp, mkdir, readdir, lstat, realpath } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const assets = fileURLToPath(new URL('./assets/', import.meta.url))

/** Materialize real public files for both Vite and the host's restricted source-preview root. */
export async function prepareNativeSurfaceAssets(root) {
  const base = await realpath(root)
  let destination = base
  for (const part of ['public', 'assets', 'vendor', 'native-surfaces']) {
    destination = join(destination, part)
    const existing = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) throw new Error('Native surface assets require real directories')
    await mkdir(destination, { recursive: true })
    const path = relative(base, await realpath(destination))
    if (path.startsWith('..') || isAbsolute(path)) throw new Error('Native surface assets escaped plugin root')
  }
  for (const entry of await readdir(assets, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(html|js|css)$/.test(entry.name)) throw new Error('Unexpected native surface asset')
    const target = resolve(destination, entry.name)
    const previous = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('Native surface asset destination must be a regular file')
    await cp(join(assets, entry.name), target, { force: true, dereference: false })
  }
  return destination
}

export function nativeSurfacesAssets() {
  return { name: 'enest-native-surfaces-assets', async configResolved(config) { await prepareNativeSurfaceAssets(config.root) } }
}
