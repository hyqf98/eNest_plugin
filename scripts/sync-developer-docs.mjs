#!/usr/bin/env node
/** Publish the host's authoritative guides in this independently usable plugin repository. */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flag = process.argv.indexOf('--host-root')
const host = resolve(flag >= 0 ? process.argv[flag + 1] : join(repository, '..'))
const source = join(host, 'docs/site/plugin'), target = join(repository, 'docs/developer')
const check = process.argv.includes('--check')
const files = (await readdir(source)).filter(name => name.endsWith('.md') && !name.startsWith('_')).sort()
if (!check) await mkdir(target, { recursive: true })
let stale = false
for (const file of files) {
  const expected = await readFile(join(source, file), 'utf8')
  if (check) {
    const current = await readFile(join(target, file), 'utf8').catch(() => '')
    if (current !== expected) { stale = true; console.error(`Stale developer guide: ${file}`) }
  } else await writeFile(join(target, file), expected)
}
if (stale) process.exitCode = 1
else console.log(`${check ? 'Checked' : 'Synced'} ${files.length} developer guides`)
