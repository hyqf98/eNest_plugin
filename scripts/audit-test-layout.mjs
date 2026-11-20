import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const excluded = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', 'release', 'tests', '.cache', '.git'])
const misplaced = []

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!excluded.has(entry.name)) await inspect(path)
    } else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) misplaced.push(relative(root, path))
  }
}

for (const section of ['plugins', 'packages', 'scripts']) await inspect(join(root, section))
if (misplaced.length) throw new Error(`Move test sources into tests/:\n${misplaced.sort().join('\n')}`)
console.log('Test file layout valid; no test executed')
