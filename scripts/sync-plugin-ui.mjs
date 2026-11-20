import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const mode = process.argv[2] ?? '--check'
if (!['--check', '--write'].includes(mode)) throw new Error('Usage: sync-plugin-ui.mjs [--check|--write]')
const root = fileURLToPath(new URL('../', import.meta.url))
const templates = new Map(await Promise.all(['index.jsx', 'pk-ui.css'].map(async name =>
  [name, await readFile(join(root, 'templates/plugin-ui', name))])))
const differences = []
let count = 0
for (const plugin of await readdir(join(root, 'plugins'), { withFileTypes: true })) {
  if (!plugin.isDirectory()) continue
  const ui = join(root, 'plugins', plugin.name, 'src/ui')
  const directory = await lstat(ui).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!directory) continue
  if (!directory.isDirectory()) throw new Error(`Invalid UI directory: ${ui}`)
  const entries = await readdir(ui)
  for (const [name, canonical] of templates) {
    if (name === 'index.jsx' && !entries.includes(name)) continue
    const target = join(ui, name)
    if (entries.includes(name) && !(await lstat(target)).isFile()) throw new Error(`Invalid template target: ${target}`)
    count++
    if (entries.includes(name) && canonical.equals(await readFile(target))) continue
    differences.push(`${plugin.name}/src/ui/${name}`)
    if (mode === '--write') await writeFile(target, canonical)
  }
}
if (mode === '--check' && differences.length) throw new Error(`Plugin UI templates differ:\n${differences.join('\n')}`)
console.log(`Plugin UI: ${count} template copies checked, ${differences.length} updated`)
