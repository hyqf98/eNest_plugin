import { cp, mkdir, lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const assets = fileURLToPath(new URL('./assets/', import.meta.url))

const isFontFile = name => name === 'lxgw.css' || name === 'OFL.txt' || name === 'LICENSE' || /^lxgwwenkailite-regular-subset-\d+\.woff2$/.test(name)

/**
 * 把霞鹜文楷（OFL）写进插件的 public/assets/vendor/fonts/。
 *
 * 只有需要「运行时按路径取字体」的插件才用这个（把 lxgw.css 当普通 CSS import 的
 * 插件不需要它，Vite 会自己处理 woff2 并指纹化）。物化出来的目录被 .gitignore
 * 忽略，唯一副本保存在本包 assets/，避免每个插件各存一份 4.1M 的重复。
 *
 * 与 @enest/native-surfaces 同一手法：共享包持有唯一副本，构建时物化进各插件，
 * 每个 .enestplugin 仍然自包含、离线可用。
 */
export async function prepareLxgwFonts(root) {
  const base = await realpath(root)
  let destination = base
  for (const part of ['public', 'assets', 'vendor', 'fonts']) {
    destination = join(destination, part)
    const existing = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) throw new Error('LXGW font assets require real directories')
    await mkdir(destination, { recursive: true })
    const path = relative(base, await realpath(destination))
    if (path.startsWith('..') || isAbsolute(path)) throw new Error('LXGW font assets escaped plugin root')
  }
  for (const entry of await readdir(assets, { withFileTypes: true })) {
    if (!entry.isFile() || !isFontFile(entry.name)) throw new Error(`Unexpected LXGW font asset: ${entry.name}`)
    const target = resolve(destination, entry.name)
    const previous = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('LXGW font asset destination must be a regular file')
    await cp(join(assets, entry.name), target, { force: true, dereference: false })
  }
  return destination
}

/** Vite 插件：configResolved 阶段物化，dev 与 build 行为一致。 */
export function lxgwFonts() {
  return { name: 'enest-lxgw-fonts', async configResolved(config) { await prepareLxgwFonts(config.root) } }
}
