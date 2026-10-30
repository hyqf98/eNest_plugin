#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, loadConfigFromFile, mergeConfig } from 'vite'
import { repositoryRoot as root, pluginIds, resolvePluginSource, pluginHtmlEntries } from './plugin-contract.mjs'
import { validateSource } from './validate-manifests.mjs'
import { validateDistribution } from './validate-dist.mjs'
import { buildBackend } from './build-backend.mjs'
import { distributionDirectory, normalizeTarget, writeDistributionTarget } from './distribution-target.mjs'
import { loadPluginBuildHooks } from './plugin-build-hooks.mjs'

/** Business index plus manifest-declared Home entries use the same portable Vite build. */
export async function buildPlugin(id, { release = true, runtime = false, repositoryRoot = root, target = 'universal' } = {}) {
  normalizeTarget(target)
  const { source, manifest } = resolvePluginSource(id, repositoryRoot)
  const destination = distributionDirectory(source, target, repositoryRoot)
  const errors = validateSource(source, { release })
  if (errors.length) throw new Error(errors.join('\n'))
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
  const hooks = await loadPluginBuildHooks(source)
  await hooks.afterBuild?.({ source, directory: destination, repositoryRoot, target, runtime, release })
  await writeDistributionTarget(destination, target)
  await validateDistribution(destination, { source, repositoryRoot, target, release, requireRuntime: runtime })
  return destination
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv.slice(2)
  const target = normalizeTarget(input.find(value => value.startsWith('--target='))?.slice('--target='.length))
  const args = input.filter(value => value !== '--runtime' && !value.startsWith('--target='))
  const runtime = process.argv.includes('--runtime')
  for (const id of args.length ? args : pluginIds()) console.log(`Built ${id}: ${await buildPlugin(id, { runtime, target })}`)
}
