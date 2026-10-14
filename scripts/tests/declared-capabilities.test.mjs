import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginIds, readManifest, repositoryRoot, requiresUserConsent } from '../plugin-contract.mjs'

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).map(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sources(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? readFileSync(path, 'utf8') : ''
  }).join('\n').replace(/\?/g, '')
}

const plugins = pluginIds().map(id => {
  const directory = join(repositoryRoot, 'plugins', id)
  return { id, manifest: readManifest(directory), source: sources(join(directory, 'src')) }
})

// These are host contracts exercised by PluginKit and direct official UI actions.
// This does not replace host-side permission checks or runtime integration tests.
test('official PluginKit consumers declare only the sensitive capabilities their UI invokes', () => {
  const rules = [
    [/kit\.save(?:Text|File)\(/, 'fs.write'],
    [/kit\.copy\(/, 'clipboard.write']
  ]
  for (const plugin of plugins) for (const [pattern, permission] of rules) {
    if (pattern.test(plugin.source)) assert.ok(plugin.manifest.permissions?.includes(permission), `${plugin.id} must declare ${permission}`)
  }
  for (const plugin of plugins) for (const permission of plugin.manifest.permissions ?? []) {
    assert.ok(requiresUserConsent(permission), `${plugin.id}: built-in ${permission} does not belong in its consent declaration`)
  }
})

test('official clipboard, file export and pin actions declare host permissions', () => {
  const permissions = {
    'ui.setTitle': 'ui.setTitle',
    'clipboard.readText': 'clipboard.read',
    'clipboard.writeText': 'clipboard.write',
    'clipboard.readImage': 'clipboard.readImage',
    'clipboard.writeImage': 'clipboard.writeImage',
    'shell.saveFile': 'fs.write',
    'shell.saveTextFile': 'fs.write',
    'pin.open': 'pin.create',
    'localFiles.read': 'fs.read',
    'localFiles.fromDrop': 'fs.read',
    'contribute.registerQuickProvider': 'contribute',
    'contribute.respondQuickQuery': 'contribute',
    'contribute.unregisterQuickProvider': 'contribute'
  }
  for (const plugin of plugins) for (const call of plugin.source.matchAll(/\b(?:api|host|enest|zapi)\.([\w]+(?:\.[\w]+)*)\s*\(/g)) {
    const permission = permissions[call[1]]
    if (permission && requiresUserConsent(permission)) assert.ok(plugin.manifest.permissions?.includes(permission), `${plugin.id}: ${call[1]} requires ${permission}`)
  }
})
