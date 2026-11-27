#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createReadStream, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { zipSync } from 'fflate'
import { buildPlugin } from './build-plugin.mjs'
import { repositoryRoot, pluginIds, resolvePluginSource, readManifest } from './plugin-contract.mjs'
import { validateDistribution } from './validate-dist.mjs'
import { distributionDirectory, normalizeTarget, platformPackagePlan, projectPlatformDistribution, readDistributionTarget } from './distribution-target.mjs'
import { loadPluginBuildHooks } from './plugin-build-hooks.mjs'

async function createArchive(directory, output) {
  try {
    execFileSync('zip', ['-r', '-q', resolve(output), '.'], { cwd: directory })
    return
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  // Windows development hosts often lack Info-ZIP; use the in-repo pure-JS fallback.
  // Release CI still uses the platform zip binary, which preserves Unix modes.
  const files = {}
  async function walk(current, prefix = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(absolute, relative)
      else if (entry.isFile()) files[relative] = new Uint8Array(await readFile(absolute))
      else throw new Error(`Non-regular file cannot be archived: ${relative}`)
    }
  }
  await walk(directory)
  await writeFile(output, zipSync(files, { level: 6 }))
}

export async function packPlugin(id, { repositoryRoot: root = repositoryRoot, outDir = join(root, 'dist'), build = true, target = 'universal', project = false } = {}) {
  normalizeTarget(target)
  const { slug, source } = resolvePluginSource(id, root)
  await mkdir(outDir, { recursive: true })
  let stage
  try {
    let directory
    if (project) {
      if (target === 'universal') throw new Error('Projection requires a platform target')
      const portable = join(source, 'dist')
      await validateDistribution(portable, { source, repositoryRoot: root })
      stage = await mkdtemp(join(outDir, '.platform-stage-'))
      directory = await projectPlatformDistribution(portable, join(stage, slug), source, { root, target })
    } else directory = build ? await buildPlugin(slug, { repositoryRoot: root, target }) : distributionDirectory(source, target, root)
    await validateDistribution(directory, { source, repositoryRoot: root, target })
    if (await readDistributionTarget(directory) !== target) throw new Error(`Refusing to package a different distribution target as ${target}`)
    const manifest = readManifest(directory)
    const suffix = target === 'universal' ? '' : `-${target}`
    const name = `${slug}@${manifest.version}${suffix}.enestplugin`, output = join(outDir, name)
    if (resolve(output, '..') !== resolve(outDir)) throw new Error('Invalid package output path')
    // Keep the last valid archive if packing fails; only publish complete final bytes.
    const temporary = `${output}.${process.pid}.tmp.zip`
    try {
      await rm(temporary, { force: true })
      await createArchive(directory, temporary)
      await rename(temporary, output)
    } finally { await rm(temporary, { force: true }) }
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(output)) { hash.update(chunk); size += chunk.length }
    const hooks = await loadPluginBuildHooks(source)
    await hooks.afterPack?.({ source, directory, repositoryRoot: root, target, project, outDir })
    return { name, path: output, size, sha256: hash.digest('hex'), target }
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
      for (const variant of platformPackagePlan(resolvePluginSource(id).source).supportedTargets) {
        console.log(JSON.stringify(await packPlugin(id, { build: false, project: true, target: variant })))
      }
    }
  }
}
