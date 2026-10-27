import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertRuntimeTarget, DSH_VERSION, repositoryRoot as defaultRepositoryRoot } from './runtime-contract.mjs'

export async function afterBuild({ directory, repositoryRoot = defaultRepositoryRoot, target = 'universal', runtime = false, project = false }) {
  if (runtime !== true) return
  if (project) throw new Error('DSH runtime cannot be installed into a projected distribution')
  assertRuntimeTarget(target)
  const cache = join(repositoryRoot, 'dist/runtime-cache', `dsh-${DSH_VERSION}-${process.platform}-${process.arch}`)
  if (!existsSync(join(cache, 'node_modules/@deepseek-ai/dsh/package.json'))) {
    await mkdir(cache, { recursive: true })
    await writeFile(join(cache, 'package.json'), JSON.stringify({ name: 'enest-dsh-runtime', version: '1.0.0', private: true, platform: process.platform, arch: process.arch }))
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', `@deepseek-ai/dsh@${DSH_VERSION}`, '--omit=dev', '--no-audit', '--no-fund'], { cwd: cache, stdio: 'inherit' })
    if (result.status !== 0) { await rm(cache, { recursive: true, force: true }); throw new Error('DSH runtime install failed') }
  }
  await cp(cache, join(directory, 'runtime'), { recursive: true, dereference: true })
}

export async function validateDistribution({ directory, requireRuntime = false, target = 'universal' }) {
  const runtime = join(directory, 'runtime')
  if (requireRuntime === true && !existsSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))) throw new Error('DSH runtime is missing')
  if (!existsSync(runtime) || target === 'universal') return
  let manifest
  try { manifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')) }
  catch (cause) { throw new Error('DSH runtime must declare platform and arch for a targeted distribution', { cause }) }
  if (typeof manifest?.platform !== 'string' || typeof manifest?.arch !== 'string') throw new Error('DSH runtime must declare platform and arch for a targeted distribution')
  if (`${manifest.platform}-${manifest.arch}` !== target) throw new Error('DSH runtime does not match the distribution target')
}

export async function afterPack({ directory, repositoryRoot = defaultRepositoryRoot, outDir = join(repositoryRoot, 'dist'), target = 'universal', project = false }) {
  if (project || !existsSync(join(directory, 'runtime'))) return
  // The runtime CLI builds this plugin before packing, so hook loading must not import it.
  const { packDshRuntime } = await import('./pack-runtime.mjs')
  return packDshRuntime(directory, { outDir, target })
}
