import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { localFile } from './plugin-contract.mjs'

/** Build extensions are trusted source tools, never loaded from a distribution. */
export async function loadPluginBuildHooks(source) {
  const spec = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).enestBuild
  if (spec === undefined) return {}
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.entry !== 'string') throw new Error('enestBuild requires a plugin-local entry')
  const hooks = await import(pathToFileURL(localFile(source, spec.entry)).href)
  for (const name of ['afterBuild', 'validateDistribution', 'afterPack']) {
    if (hooks[name] !== undefined && typeof hooks[name] !== 'function') throw new Error(`enestBuild ${name} must be a function`)
  }
  return hooks
}
