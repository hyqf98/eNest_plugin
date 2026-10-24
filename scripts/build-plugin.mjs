#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build, loadConfigFromFile, mergeConfig } from 'vite'
import { repositoryRoot as root, pluginIds, readManifest, pluginHtmlEntries, DSH_DIR, DSH_VERSION, DSH_BUNDLED_RUNTIME } from './plugin-contract.mjs'
import { validateSource } from './validate-manifests.mjs'
import { validateDistribution } from './validate-dist.mjs'
import { buildBackend } from './build-backend.mjs'
import { distributionDirectory, normalizeTarget, writeDistributionTarget } from './distribution-target.mjs'

/** Business index plus manifest-declared Home entries use the same portable Vite build. */
export async function buildPlugin(id, { release = true, runtime = DSH_BUNDLED_RUNTIME, repositoryRoot = root, target = 'universal' } = {}) {
  normalizeTarget(target)
  if (!pluginIds(repositoryRoot).includes(id)) throw new Error(`Unknown plugin: ${id}`)
  const source = join(repositoryRoot, 'plugins', id), destination = distributionDirectory(source, target, repositoryRoot)
  const errors = validateSource(source, { release })
  if (errors.length) throw new Error(errors.join('\n'))
  const manifest = readManifest(source)
  const inputs = pluginHtmlEntries(manifest).map(entry => join(source, entry))
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, undefined, source)
  const config = mergeConfig(loaded?.config ?? {}, {
    configFile: false, root: source, base: './', publicDir: join(source, 'public'), logLevel: 'warn',
    // Official plugins are React-based (aligned with the shell); JSX transform must not depend on per-plugin config.
    esbuild: { jsx: 'automatic' },
    build: { outDir: destination, emptyOutDir: true, target: 'chrome120', sourcemap: false, assetsDir: 'assets/app',
      rollupOptions: { input: inputs, output: { entryFileNames: 'assets/app/[name]-[hash].js', chunkFileNames: 'assets/app/[name]-[hash].js', assetFileNames: 'assets/app/[name]-[hash][extname]' } } },
    worker: { format: 'es' }
  })
  // Do not allow a framework config to redirect output outside the distribution.
  if (config.build.lib || config.build.ssr) throw new Error(`${id}: plugin builds must target index.html and declared home HTML entries`)
  await build(config)
  delete manifest.development
  await writeFile(join(destination, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n')
  await buildBackend(source, destination, { root: repositoryRoot, target })
  if (runtime && id === DSH_DIR) {
    // DSH owns this optional private backend attachment; the installer rule is generic.
    const cache = join(repositoryRoot, 'dist/runtime-cache', `dsh-${DSH_VERSION}-${process.platform}-${process.arch}`)
    if (!existsSync(join(cache, 'node_modules/@deepseek-ai/dsh/package.json'))) {
      await mkdir(cache, { recursive: true })
      await writeFile(join(cache, 'package.json'), JSON.stringify({ name: 'enest-dsh-runtime', version: '1.0.0', private: true, platform: process.platform, arch: process.arch }))
      const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', `@deepseek-ai/dsh@${DSH_VERSION}`, '--omit=dev', '--no-audit', '--no-fund'], { cwd: cache, stdio: 'inherit' })
      if (result.status !== 0) { await rm(cache, { recursive: true, force: true }); throw new Error('DSH runtime install failed') }
    }
    await cp(cache, join(destination, 'runtime'), { recursive: true, dereference: true })
  }
  await writeDistributionTarget(destination, target)
  await validateDistribution(destination, { release, requireRuntime: runtime })
  return destination
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv.slice(2)
  const target = normalizeTarget(input.find(value => value.startsWith('--target='))?.slice('--target='.length))
  const args = input.filter(value => value !== '--runtime' && !value.startsWith('--target='))
  const runtime = process.argv.includes('--runtime') || DSH_BUNDLED_RUNTIME
  for (const id of args.length ? args : pluginIds()) console.log(`Built ${id}: ${await buildPlugin(id, { runtime, target })}`)
}
