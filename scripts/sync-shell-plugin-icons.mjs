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
const ids = (await readdir(join(repository, 'plugins'))).filter(id => id.startsWith('com.enest.')).sort()
const icons = {}
for (const id of ids) {
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(id) || Object.hasOwn(icons, id)) throw new Error(`Invalid or duplicate plugin ID: ${id}`)
  const manifest = JSON.parse(await readFile(join(repository, 'plugins', id, 'plugin.json'), 'utf8'))
  if (manifest.id !== id || manifest.icon !== 'assets/market/icon.svg') throw new Error(`Unexpected icon contract: ${id}`)
  icons[id] = (await readFile(join(repository, 'plugins', id, 'public/assets/market/icon.svg'), 'utf8')).trim()
}
const legacy = JSON.parse(await readFile(join(repository, 'scripts/legacy-plugin-icons.json'), 'utf8'))
for (const [id, value] of Object.entries(legacy)) {
  if (!Object.hasOwn(icons, id) || !/^\d+\.\d+\.\d+$/.test(value.throughVersion) ||
      !Array.isArray(value.sha256) || !value.sha256.length || value.sha256.some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error(`Invalid legacy icon signature: ${id}`)
  }
}
const target = join(host, 'src/shared/builtinPluginIcons.ts')
const output = `/** Generated from plugin market SVGs. Run eNest_plugin/scripts/sync-shell-plugin-icons.mjs; do not hand edit. */\nexport const BUILTIN_PLUGIN_ICON_SVGS: Readonly<Record<string, string>> = ${JSON.stringify(icons, null, 2)}\n\n/** Exact legacy artwork signatures; the version cap only applies to remote default URLs. */\nexport const LEGACY_PLUGIN_ICONS: Readonly<Record<string, { throughVersion: string; sha256: readonly string[] }>> = ${JSON.stringify(legacy, null, 2)}\n`
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
