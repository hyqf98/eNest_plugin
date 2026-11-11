import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { backendRuntimeExclusions } from '../backend-package-files.mjs'
import { buildBackend } from '../build-backend.mjs'

/**
 * 覆盖 enestBackend.runtimeExcluded：
 * - 形态校验严格（合法包名、不重复、不与 optionalExcluded/platformPackages 冲突）；
 * - 构建期必须能在锁定依赖图中解析到，且不能点名根依赖；
 * - 命中的传递依赖连同其整棵子树不复制，并记入 dependency-inventory.json；
 * - 不影响仍在使用的兄弟依赖与重复版本目录布局。
 */

const spec = extra => ({ dependencies: ['fixture-root'], runtimeExcluded: ['fixture-unused'], ...extra })

async function fixture(t, { runtimeExcluded = ['fixture-unused'], extraPackages = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'enest runtime-excluded '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'plugins/fixture'), destination = join(source, 'dist')
  await mkdir(join(source, 'backend'), { recursive: true })
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ backend: { entry: 'backend/index.cjs' }, permissions: ['backend.node'] }))
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'fixture',
    dependencies: { 'fixture-root': '1.0.0', 'fixture-unused': '1.0.0' },
    enestBackend: { entry: 'backend/index.js', dependencies: ['fixture-root'], runtimeExcluded },
  }))
  await writeFile(join(source, 'backend/index.js'), "module.exports = require('fixture-root')")

  const lock = { lockfileVersion: 3, packages: {} }
  const addPackage = async (name, pkg = {}, files = { 'index.js': 'module.exports = 1' }, location = `node_modules/${name}`) => {
    const directory = join(root, location)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }))
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(join(directory, file, '..'), { recursive: true })
      await writeFile(join(directory, file), contents)
    }
    lock.packages[location] = { version: pkg.version || '1.0.0' }
  }

  // 根依赖同时依赖一个仍在使用的传递依赖，以及一个声明为运行时不用的传递依赖。
  await addPackage('fixture-root', { dependencies: { 'fixture-used': '1.0.0', 'fixture-unused': '1.0.0' } }, { 'index.js': "module.exports = require('fixture-used')" })
  await addPackage('fixture-used', {}, { 'index.js': 'module.exports = 42', LICENSE: 'MIT fixture' })
  // 该包声明了自己的一整棵子树，子树必须随它一起消失。
  await addPackage('fixture-unused', { dependencies: { 'fixture-unused-child': '1.0.0' } }, {
    'index.js': 'module.exports = 0',
    'lib/large.js': 'x'.repeat(1024),
    LICENSE: 'MIT unused fixture',
  })
  await addPackage('fixture-unused-child', {}, { 'index.js': 'module.exports = 0', LICENSE: 'MIT child fixture' })
  for (const [name, definition] of Object.entries(extraPackages)) await addPackage(name, ...definition)
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock))
  return { root, source, destination }
}

test('runtimeExcluded accepts only legal, unique, non-conflicting names', () => {
  assert.deepEqual([...backendRuntimeExclusions(spec())], ['fixture-unused'])
  assert.equal(backendRuntimeExclusions({ dependencies: [] }).size, 0)
  for (const value of ['fixture-unused', {}, null, 42]) assert.throws(() => backendRuntimeExclusions({ dependencies: [], runtimeExcluded: value }), /must be an array/)
  for (const name of ['', 'fixture unused', '../escape', 'fixture/../unused', '@scope', 'fixture\u0000unused']) {
    assert.throws(() => backendRuntimeExclusions({ dependencies: [], runtimeExcluded: [name] }), /Invalid backend runtime exclusion/)
  }
  assert.throws(() => backendRuntimeExclusions({ dependencies: [], runtimeExcluded: ['fixture-unused', 'fixture-unused'] }), /Duplicate backend runtime exclusion/)
  assert.throws(() => backendRuntimeExclusions({ dependencies: [], runtimeExcluded: ['fixture-unused'], optionalExcluded: ['fixture-unused'] }), /conflicts with optionalExcluded/)
  assert.throws(() => backendRuntimeExclusions({ dependencies: [], runtimeExcluded: ['fixture-unused'], platformPackages: ['fixture-unused'] }), /conflicts with platformPackages/)
})

test('declared runtime-unused transitive dependency is not copied, nor its subtree', async t => {
  const f = await fixture(t)
  await buildBackend(f.source, f.destination, { root: f.root })
  const backend = join(f.destination, 'backend')
  assert.equal(existsSync(join(backend, 'node_modules/fixture-root')), true)
  assert.equal(existsSync(join(backend, 'node_modules/fixture-used')), true)
  assert.equal(existsSync(join(backend, 'node_modules/fixture-unused')), false)
  assert.equal(existsSync(join(backend, 'node_modules/fixture-unused-child')), false)
  // 源依赖保持原样，过滤只发生在复制阶段。
  assert.equal(existsSync(join(f.root, 'node_modules/fixture-unused/lib/large.js')), true)

  const inventory = JSON.parse(await readFile(join(backend, 'dependency-inventory.json'), 'utf8'))
  assert.deepEqual(inventory.runtimeExcluded, [{ name: 'fixture-unused', version: '1.0.0', path: 'node_modules/fixture-unused' }])
  assert.deepEqual(inventory.dependencies.map(pkg => pkg.name).sort(), ['fixture-root', 'fixture-used'])
  assert.equal(inventory.dependencies.some(pkg => pkg.name === 'fixture-unused'), false)
})

test('runtimeExcluded cannot name a declared root dependency', async t => {
  const f = await fixture(t, { runtimeExcluded: ['fixture-root'] })
  await assert.rejects(buildBackend(f.source, f.destination, { root: f.root }), /must not name a declared root dependency/)
})

test('runtimeExcluded rejects names outside the locked dependency graph', async t => {
  const f = await fixture(t, { runtimeExcluded: ['fixture-absent'] })
  await assert.rejects(buildBackend(f.source, f.destination, { root: f.root }), /not in the locked dependency graph/)
})

test('without the declaration the same transitive dependency stays in the package', async t => {
  const f = await fixture(t, { runtimeExcluded: [] })
  await buildBackend(f.source, f.destination, { root: f.root })
  assert.equal(existsSync(join(f.destination, 'backend/node_modules/fixture-unused')), true)
  assert.equal(existsSync(join(f.destination, 'backend/node_modules/fixture-unused-child')), true)
  const inventory = JSON.parse(await readFile(join(f.destination, 'backend/dependency-inventory.json'), 'utf8'))
  assert.deepEqual(inventory.runtimeExcluded, [])
})

test('packageFilesExcluded may target a transitive dependency but not an unknown package', async t => {
  const root = await mkdtemp(join(tmpdir(), 'enest package files transitive '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'plugins/fixture'), destination = join(source, 'dist')
  await mkdir(join(source, 'backend'), { recursive: true })
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ backend: { entry: 'backend/index.cjs' }, permissions: ['backend.node'] }))
  await writeFile(join(source, 'backend/index.js'), "module.exports = require('fixture-root')")
  const lock = { lockfileVersion: 3, packages: { 'node_modules/fixture-root': { version: '1.0.0' }, 'node_modules/fixture-transitive': { version: '1.0.0' } } }
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock))
  for (const [name, pkg, files] of [
    ['fixture-root', { dependencies: { 'fixture-transitive': '1.0.0' } }, { 'index.js': "module.exports = require('fixture-transitive')" }],
    ['fixture-transitive', { main: './lib/index.js' }, { 'index.js': 'module.exports = 1', 'lib/index.js': 'module.exports = 7', 'docs/guide.md': 'docs', LICENSE: 'MIT' }],
  ]) {
    const directory = join(root, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }))
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(join(directory, file, '..'), { recursive: true })
      await writeFile(join(directory, file), contents)
    }
  }
  const writeManifest = async packageFilesExcluded => writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'fixture',
    dependencies: { 'fixture-root': '1.0.0', 'fixture-transitive': '1.0.0' },
    enestBackend: { entry: 'backend/index.js', dependencies: ['fixture-root'], packageFilesExcluded },
  }))

  await writeManifest({ 'fixture-transitive': ['docs'] })
  await buildBackend(source, destination, { root })
  const copied = join(destination, 'backend/node_modules/fixture-transitive')
  assert.equal(existsSync(join(copied, 'docs')), false)
  assert.equal(existsSync(join(copied, 'lib/index.js')), true)
  assert.equal(existsSync(join(copied, 'LICENSE')), true)

  await writeManifest({ 'fixture-absent': ['docs'] })
  await assert.rejects(buildBackend(source, destination, { root }), /not in the locked backend dependency graph/)
})
