#!/usr/bin/env node
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildPlugin } from './build-plugin.mjs'
import { repositoryRoot, pluginIds, readManifest, DSH_ID, DSH_VERSION } from './plugin-contract.mjs'
import { validateDistribution } from './validate-dist.mjs'

export async function packPlugin(id, { outDir = join(repositoryRoot, 'dist'), build = true } = {}) {
  if (!pluginIds().includes(id)) throw new Error(`Unknown plugin: ${id}`)
  const directory = build ? await buildPlugin(id) : join(repositoryRoot, 'plugins', id, 'dist')
  await validateDistribution(directory)
  const manifest = readManifest(directory)
  await mkdir(outDir, { recursive: true })
  const name = `${manifest.id}@${manifest.version}.enestplugin`, output = join(outDir, name)
  if (resolve(output, '..') !== resolve(outDir)) throw new Error('Invalid package output path')
  await rm(output, { force: true })
  execFileSync('zip', ['-r', '-q', resolve(output), '.'], { cwd: directory })
  const data = await readFile(output)
  if (id === DSH_ID) {
    const runtimeName = `dsh-runtime-${DSH_VERSION}-${process.platform}-${process.arch}.tgz`, runtimePath = join(outDir, runtimeName)
    execFileSync('tar', ['-C', join(directory, 'runtime'), '-czf', runtimePath, './node_modules', './package.json'])
    await writeFile(runtimePath + '.sha256', createHash('sha256').update(await readFile(runtimePath)).digest('hex') + '  ' + runtimeName + '\n')
  }
  return { name, path: output, size: data.length, sha256: createHash('sha256').update(data).digest('hex') }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv.slice(2), ids = input[0] === '--all' ? pluginIds() : input.filter(value => !value.startsWith('--'))
  if (!ids.length) throw new Error('usage: pack-plugin.mjs <id>|--all [--no-build]')
  for (const id of ids) console.log(JSON.stringify(await packPlugin(id, { build: !input.includes('--no-build') })))
}
