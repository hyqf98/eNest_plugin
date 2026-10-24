#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildPlugin } from './build-plugin.mjs'
import { repositoryRoot, pluginIds, readManifest, DSH_DIR } from './plugin-contract.mjs'
import { packDshRuntime } from './pack-dsh-runtime.mjs'
import { validateDistribution } from './validate-dist.mjs'
import { distributionDirectory, normalizeTarget, platformPackagePlan, projectPlatformDistribution, readDistributionTarget } from './distribution-target.mjs'

export async function packPlugin(id, { repositoryRoot: root = repositoryRoot, outDir = join(root, 'dist'), build = true, target = 'universal', project = false } = {}) {
  normalizeTarget(target)
  if (!pluginIds(root).includes(id)) throw new Error(`Unknown plugin: ${id}`)
  const source = join(root, 'plugins', id)
  await mkdir(outDir, { recursive: true })
  let stage
  try {
    let directory
    if (project) {
      if (target === 'universal') throw new Error('Projection requires a platform target')
      const portable = join(source, 'dist')
      await validateDistribution(portable)
      stage = await mkdtemp(join(outDir, '.platform-stage-'))
      directory = await projectPlatformDistribution(portable, join(stage, id), source, { root, target })
    } else directory = build ? await buildPlugin(id, { repositoryRoot: root, target }) : distributionDirectory(source, target, root)
    await validateDistribution(directory)
    if (await readDistributionTarget(directory) !== target) throw new Error(`Refusing to package a different distribution target as ${target}`)
    const manifest = readManifest(directory)
    const suffix = target === 'universal' ? '' : `-${target}`
    const name = `${id}@${manifest.version}${suffix}.enestplugin`, output = join(outDir, name)
    if (resolve(output, '..') !== resolve(outDir)) throw new Error('Invalid package output path')
    // Keep the last valid archive if packing fails; only publish complete final bytes.
    const temporary = `${output}.${process.pid}.tmp.zip`
    try {
      await rm(temporary, { force: true })
      execFileSync('zip', ['-r', '-q', resolve(temporary), '.'], { cwd: directory })
      await rename(temporary, output)
    } finally { await rm(temporary, { force: true }) }
    const data = await readFile(output)
    if (id === DSH_DIR && existsSync(join(directory, 'runtime'))) await packDshRuntime(directory, { outDir })
    return { name, path: output, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), target }
  } finally { if (stage) await rm(stage, { recursive: true, force: true }) }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv.slice(2), ids = input.includes('--all') ? pluginIds() : input.filter(value => !value.startsWith('--'))
  const target = normalizeTarget(input.find(value => value.startsWith('--target='))?.slice('--target='.length))
  const variants = input.includes('--platform-variants')
  if (!ids.length) throw new Error('usage: pack-plugin.mjs <id>|--all [--no-build] [--target=os-arch|--platform-variants]')
  if (variants && target !== 'universal') throw new Error('--target and --platform-variants are mutually exclusive')
  for (const id of ids) {
    console.log(JSON.stringify(await packPlugin(id, { build: !input.includes('--no-build'), target })))
    if (variants) {
      for (const variant of platformPackagePlan(join(repositoryRoot, 'plugins', id)).supportedTargets) {
        console.log(JSON.stringify(await packPlugin(id, { build: false, project: true, target: variant })))
      }
    }
  }
}
