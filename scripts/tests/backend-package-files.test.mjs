import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { backendPackageFileExclusions, assertPackageFilesCanBeExcluded } from '../backend-package-files.mjs'
import { buildBackend } from '../build-backend.mjs'

const spec = paths => ({ dependencies: ['fixture-driver'], packageFilesExcluded: { 'fixture-driver': paths } })

async function fixture(t, packageOverrides = {}, extraFiles = {}) {
  const root = await mkdtemp(join(tmpdir(), 'enest-package-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'plugins/fixture'), directory = join(root, 'node_modules/fixture-driver')
  const files = {
    'plugins/fixture/plugin.json': JSON.stringify({ backend: { entry: 'backend/index.cjs' }, permissions: ['backend.node'] }),
    'plugins/fixture/package.json': JSON.stringify({ name: 'fixture', dependencies: { 'fixture-driver': '1.0.0' }, enestBackend: { entry: 'backend/index.js', ...spec(['native/build']) } }),
    'plugins/fixture/backend/index.js': "module.exports = require('fixture-driver')",
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/fixture-driver': { version: '1.0.0' } } }),
    'node_modules/fixture-driver/package.json': JSON.stringify({ name: 'fixture-driver', version: '1.0.0', main: './lib/index.js', ...packageOverrides }),
    'node_modules/fixture-driver/lib/index.js': "try { module.exports = require('../native/build/driver.node') } catch { module.exports = require('./value.js') }",
    'node_modules/fixture-driver/lib/value.js': 'module.exports = 42',
    'node_modules/fixture-driver/LICENSE': 'MIT fixture license',
    'node_modules/fixture-driver/native/build/driver.node': 'optional native fixture',
    ...Object.fromEntries(Object.entries(extraFiles).map(([path, content]) => [`node_modules/fixture-driver/${path}`, content]))
  }
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, path)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, contents)
  }
  return { root, source, directory }
}

test('backend package filters accept exact local paths and reject unsafe or undeclared scopes', () => {
  assert.deepEqual([...backendPackageFileExclusions(spec(['native/build'])).get('fixture-driver')], ['native/build'])
  assert.equal(backendPackageFileExclusions({ dependencies: [] }).size, 0)
  for (const path of ['/tmp/build', '../build', 'native/../build', 'C:/build', 'native\\build', 'native//build', 'native/', '.cache/build', 'native/*', 'native/**', 'native/[ab]', 'native/{a,b}', 'native/%2e%2e/build', 'node_modules/other', 'native\u0000build']) {
    assert.throws(() => backendPackageFileExclusions(spec([path])), /Invalid exact backend package exclusion/)
  }
  for (const path of ['package.json', 'LICENSE', 'native/COPYING', 'NOTICE.txt', 'licenses/third-party.txt']) {
    assert.throws(() => backendPackageFileExclusions(spec([path])), /metadata or licenses/)
  }
  for (const paths of [null, [], 'native/build']) assert.throws(() => backendPackageFileExclusions(spec(paths)), /non-empty path array/)
  assert.throws(() => backendPackageFileExclusions(spec(['native/build', 'native/build'])), /Duplicate/)
  assert.throws(() => backendPackageFileExclusions({ dependencies: [], packageFilesExcluded: { 'fixture-driver': ['native/build'] } }), /declared backend root/)
})

test('entry points, export patterns and nested legal files cannot be filtered', async t => {
  const f = await fixture(t, { exports: { '.': './lib/index.js', './feature/*': './features/*.js' }, license: 'SEE LICENSE IN legal/terms.txt' }, { 'legal/terms.txt': 'license', 'native/build/NOTICE': 'notice' })
  for (const path of ['lib', 'lib/index.js', 'features/one.js', 'legal', 'native/build']) {
    assert.throws(() => assertPackageFilesCanBeExcluded(f.directory, 'fixture-driver', new Set([path])), /Cannot exclude/)
  }
  assert.doesNotThrow(() => assertPackageFilesCanBeExcluded(f.directory, 'fixture-driver', new Set(['optional/not-built'])))
})

test('normalized and extensionless entry targets remain protected', async t => {
  const f = await fixture(t, { main: './lib/../runtime' })
  for (const path of ['runtime', 'runtime.js', 'runtime/index.js']) {
    assert.throws(() => assertPackageFilesCanBeExcluded(f.directory, 'fixture-driver', new Set([path])), /Cannot exclude backend package entry/)
  }
})

test('fully excluded symlinks are opaque leaves but cannot hide legal files or traverse ancestors', async t => {
  const f = await fixture(t)
  await mkdir(join(f.directory, 'native/build/node_gyp_bins'))
  await symlink(f.root, join(f.directory, 'native/build/node_gyp_bins/python3'))
  assert.doesNotThrow(() => assertPackageFilesCanBeExcluded(f.directory, 'fixture-driver', new Set(['native/build'])))
  assert.throws(() => assertPackageFilesCanBeExcluded(f.directory, 'fixture-driver', new Set(['native/build/node_gyp_bins/python3/child'])), /traverses a symlink/)
  await symlink(join(f.root, 'missing-license'), join(f.directory, 'native/build/LICENSE'))
  assert.throws(() => assertPackageFilesCanBeExcluded(f.directory, 'fixture-driver', new Set(['native/build'])), /metadata or licenses/)
})

test('copy-time filters retain portable fallback, metadata, licenses and the installed source', async t => {
  const f = await fixture(t), destination = join(f.source, 'dist')
  await mkdir(join(f.directory, 'native/build/node_gyp_bins'))
  await symlink(f.root, join(f.directory, 'native/build/node_gyp_bins/python3'))
  await buildBackend(f.source, destination, { root: f.root })
  const copied = join(destination, 'backend/node_modules/fixture-driver')
  assert.equal(existsSync(join(copied, 'native/build')), false)
  assert.equal(existsSync(join(f.directory, 'native/build/driver.node')), true)
  assert.equal(await readFile(join(copied, 'LICENSE'), 'utf8'), 'MIT fixture license')
  assert.equal(JSON.parse(await readFile(join(copied, 'package.json'), 'utf8')).main, './lib/index.js')
  assert.equal(createRequire(join(f.root, 'verify.cjs'))(join(destination, 'backend/index.cjs')), 42)
})
