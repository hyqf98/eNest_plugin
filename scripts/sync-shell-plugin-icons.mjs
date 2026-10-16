#!/usr/bin/env node
/** Offline shell artwork is a snapshot of the same SVGs shipped by the plugins. */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostFlag = process.argv.indexOf('--host-root')
if (hostFlag >= 0 && !process.argv[hostFlag + 1]) throw new Error('--host-root requires a path')
const host = resolve(hostFlag >= 0 ? process.argv[hostFlag + 1] : join(repository, '..'))
const check = process.argv.includes('--check')
const dirs = (await readdir(join(repository, 'plugins'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
const icons = {}
for (const dir of dirs) {
  const manifest = JSON.parse(await readFile(join(repository, 'plugins', dir, 'plugin.json'), 'utf8'))
  if (!/^[a-z0-9]+(?:\.[a-zA-Z0-9-]+)+$/.test(manifest.id) || manifest.id.split('.').pop() !== dir || Object.hasOwn(icons, manifest.id)) throw new Error(`Invalid or duplicate plugin ID: ${manifest.id}`)
  if (manifest.icon !== 'assets/market/icon.svg') throw new Error(`Unexpected icon contract: ${manifest.id}`)
  icons[manifest.id] = (await readFile(join(repository, 'plugins', dir, 'public/assets/market/icon.svg'), 'utf8')).trim()
}
const target = join(host, 'src/shared/builtinPluginIcons.ts')
const output = `/** Generated from plugin market SVGs. Run eNest_plugin/scripts/sync-shell-plugin-icons.mjs; do not hand edit. */\nexport const BUILTIN_PLUGIN_ICON_SVGS: Readonly<Record<string, string>> = ${JSON.stringify(icons, null, 2)}\n`
if (check) {
  if (await readFile(target, 'utf8').catch(() => '') !== output) {
    console.error('Shell built-in plugin icon snapshot is out of date')
    process.exitCode = 1
  } else console.log(`Checked ${Object.keys(icons).length} shell plugin icons`)
} else {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, output)
  console.log(`Synced ${Object.keys(icons).length} shell plugin icons`)
}
