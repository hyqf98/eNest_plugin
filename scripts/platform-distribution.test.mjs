import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { buildBackend } from './build-backend.mjs'
import { archiveMetadata, buildRegistry } from './build-registry.mjs'
import { packPlugin } from './pack-plugin.mjs'
import { prepareRelease } from './prepare-release.mjs'
import { validateDistribution } from './validate-dist.mjs'
import { repositoryRoot } from './plugin-contract.mjs'
import { BACKEND_INVENTORY_FILE, DISTRIBUTION_TARGET_FILE, PLATFORM_TARGETS, normalizeTarget,
  distributionDirectory, packageMatchesTarget, platformPackagePlan, projectPlatformDistribution, readDistributionTarget, resolveDistributionTarget } from './distribution-target.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'enest platform # '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'plugins/native'), dist = join(source, 'dist'), outDir = join(root, 'dist')
  const template = JSON.parse(await readFile(join(repositoryRoot, 'plugins/calculator/plugin.json'), 'utf8'))
  const names = PLATFORM_TARGETS.map(target => `@fixture/native-${target}`)
  const lock = { lockfileVersion: 3, packages: {} }
  for (const name of ['native', 'portable']) {
    const dir = join(root, 'plugins', name)
    const manifest = { ...template, id: `com.github.eNest.${name}`, name, version: '1.0.0', permissions: name === 'native' ? ['backend.node'] : [] }
    if (name === 'native') manifest.backend = { entry: 'backend/index.cjs' }
    delete manifest.development
    await mkdir(join(dir, 'dist'), { recursive: true })
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest))
    await writeFile(join(dir, 'dist/plugin.json'), JSON.stringify(manifest))
    await writeFile(join(dir, 'dist/index.html'), '<!doctype html><html><body>fixture</body></html>')
    await cp(join(repositoryRoot, 'plugins/calculator/public/assets/market'), join(dir, 'dist/assets/market'), { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module',
      ...(name === 'native' ? { dependencies: { 'fixture-driver': '1.0.0' }, enestBackend: { entry: 'backend/index.cjs', dependencies: ['fixture-driver'], platformPackages: names } } : {}) }))
  }
  const nativePackages = []
  for (let index = 0; index < names.length; index++) {
    const name = names[index], target = PLATFORM_TARGETS[index], [os, cpu] = target.split('-')
    const path = `node_modules/${name}`, data = { name, version: '1.0.0', os: [os], cpu: [cpu] }
    const directory = join(root, path)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify(data))
    await writeFile(join(directory, 'bindings.node'), randomBytes(8192))
    await cp(directory, join(dist, 'backend', path), { recursive: true })
    const integrity = 'sha512-' + Buffer.alloc(64).toString('base64')
    lock.packages[path] = { ...data, resolved: `https://registry.npmjs.org/${name}/-/native-1.0.0.tgz`, integrity }
    nativePackages.push({ name, version: data.version, path, integrity })
  }
  const driver = join(root, 'node_modules/fixture-driver')
  await mkdir(driver, { recursive: true })
  await writeFile(join(driver, 'package.json'), JSON.stringify({ name: 'fixture-driver', version: '1.0.0', optionalDependencies: Object.fromEntries(names.map(name => [name, '1.0.0'])) }))
  await writeFile(join(driver, 'index.js'), 'module.exports = 42')
  lock.packages['node_modules/fixture-driver'] = { version: '1.0.0' }
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock))
  await mkdir(join(source, 'backend'), { recursive: true })
  await writeFile(join(source, 'backend/index.cjs'), "module.exports = require('fixture-driver')")
  await writeFile(join(dist, 'backend/index.cjs'), 'module.exports = 42')
  await writeFile(join(dist, BACKEND_INVENTORY_FILE), JSON.stringify({ node: '>=24', dependencies: [], platformPackages: names, nativePackages }))
  return { root, source, dist, outDir, names }
}

test('target constraints are explicit and unsupported OS/architecture/libc are not relabelled', () => {
  assert.equal(normalizeTarget(), 'universal')
  assert.throws(() => normalizeTarget('linux-arm64'), /Unsupported/)
  assert.throws(() => normalizeTarget('../../darwin-arm64'), /Unsupported/)
  assert.equal(packageMatchesTarget({ os: ['darwin'], cpu: ['arm64'] }, 'darwin-arm64'), true)
  assert.equal(packageMatchesTarget({ os: ['!darwin'] }, 'darwin-arm64'), false)
  assert.equal(packageMatchesTarget({ os: ['linux'], libc: ['musl'] }, 'linux-x64'), false)
  assert.throws(() => resolveDistributionTarget({ schemaVersion: 1 }, undefined), /must declare/)
  assert.throws(() => resolveDistributionTarget({ schemaVersion: 1, target: 'darwin-arm64' }, { target: 'universal' }), /disagree/)
  assert.equal(distributionDirectory('/fixture/plugins/database', 'darwin-arm64', '/fixture'), '/fixture/dist/platform-builds/darwin-arm64/database')
  assert.equal(distributionDirectory('/fixture/plugins/database', 'universal', '/fixture'), '/fixture/plugins/database/dist')
})

test('target backend build retains the runtime dependency and only the requested locked native package', async t => {
  const f = await fixture(t), destination = join(f.root, 'target-build')
  const packageFile = join(f.source, 'package.json'), pkg = JSON.parse(await readFile(packageFile, 'utf8'))
  pkg.dependencies[f.names[0]] = '1.0.0'
  pkg.enestBackend.dependencies.push(f.names[0])
  await writeFile(packageFile, JSON.stringify(pkg))
  await buildBackend(f.source, destination, { root: f.root, target: 'darwin-arm64' })
  const inventory = JSON.parse(await readFile(join(destination, BACKEND_INVENTORY_FILE), 'utf8'))
  assert.equal(inventory.target, 'darwin-arm64')
  assert.deepEqual(inventory.supportedTargets, PLATFORM_TARGETS)
  assert.deepEqual(inventory.platformPackages, [f.names[0]])
  assert.equal(inventory.nativePackages.length, 1)
  assert.equal(inventory.dependencies.find(pkg => pkg.name === f.names[0]).optional, undefined)
  for (const [index, name] of f.names.entries()) assert.equal(existsSync(join(destination, 'backend/node_modules', name)), index === 0)
  const require = createRequire(join(f.root, 'fixture.cjs'))
  assert.equal(require(join(destination, 'backend/index.cjs')), 42)
})

test('projection rejects overlapping directories without deleting the portable source', async t => {
  const f = await fixture(t)
  for (const destination of [f.dist, f.source, join(f.dist, 'nested')]) {
    await assert.rejects(projectPlatformDistribution(f.dist, destination, f.source, { root: f.root, target: 'darwin-arm64' }), /cannot overlap/)
    assert.ok(existsSync(join(f.dist, 'plugin.json')))
  }
})

test('projection produces smaller suffixed archive without modifying the portable source or archive', async t => {
  const f = await fixture(t)
  const portable = await packPlugin('native', { repositoryRoot: f.root, build: false })
  const before = await readFile(portable.path)
  const variant = await packPlugin('native', { repositoryRoot: f.root, build: false, project: true, target: 'darwin-arm64' })
  const entries = unzipSync(await readFile(variant.path))
  assert.equal(variant.name, 'native@1.0.0-darwin-arm64.enestplugin')
  assert.ok(variant.size < portable.size)
  assert.deepEqual(await readFile(portable.path), before)
  assert.equal(await readDistributionTarget(f.dist), 'universal')
  assert.equal(JSON.parse(strFromU8(entries[DISTRIBUTION_TARGET_FILE])).target, 'darwin-arm64')
  for (const [index, name] of f.names.entries()) {
    assert.equal(Boolean(entries[`backend/node_modules/${name}/bindings.node`]), index === 0)
    assert.ok(existsSync(join(f.dist, 'backend/node_modules', name, 'bindings.node')))
  }
  assert.ok(!(await readdir(f.outDir)).some(name => name.startsWith('.platform-stage-')))
  assert.throws(() => archiveMetadata(zipSync(entries)), /cannot be published as universal/)
})

test('registry and release retain universal fallback and select a verified platform archive', async t => {
  const f = await fixture(t)
  for (const id of ['native', 'portable']) await packPlugin(id, { repositoryRoot: f.root, build: false })
  const variant = await packPlugin('native', { repositoryRoot: f.root, build: false, project: true, target: 'darwin-arm64' })
  const universal = buildRegistry(f.root)
  const targeted = buildRegistry(f.root, { target: 'darwin-arm64' })
  assert.equal(universal.plugins[0].asset.name, 'native@1.0.0.enestplugin')
  assert.equal(targeted.plugins[0].asset.name, variant.name)
  assert.equal(targeted.plugins[1].asset.name, 'portable@1.0.0.enestplugin')
  assert.equal(targeted.plugins[0].asset.sha256, createHash('sha256').update(await readFile(variant.path)).digest('hex'))
  prepareRelease({ repositoryRoot: f.root, repository: 'fixture/plugins', tag: 'v1.0.0' })
  const released = JSON.parse(await readFile(join(f.outDir, 'registry-darwin-arm64.json'), 'utf8'))
  assert.equal(released.schemaVersion, 1)
  assert.match(released.plugins[0].asset.url, /native%401\.0\.0-darwin-arm64\.enestplugin$/)
  assert.ok(!existsSync(join(f.outDir, 'registry-win32-x64.json')))
  await writeFile(join(f.outDir, 'native@1.0.0.enestplugin'), await readFile(variant.path))
  assert.throws(() => buildRegistry(f.root), /cannot be published as universal/)
})

test('native support is checked before falling back to a universal archive', async t => {
  const f = await fixture(t), file = join(f.source, 'package.json')
  const pkg = JSON.parse(await readFile(file, 'utf8'))
  pkg.enestBackend.platformPackages = [f.names[0]]
  await writeFile(file, JSON.stringify(pkg))
  assert.throws(() => platformPackagePlan(f.source, { root: f.root, target: 'win32-x64' }), /do not support/)
  assert.throws(() => buildRegistry(f.root, { target: 'win32-x64' }), /do not support/)
})

test('archive target metadata and dependency inventory must agree and reference real native packages', async t => {
  const f = await fixture(t)
  const variant = await packPlugin('native', { repositoryRoot: f.root, build: false, project: true, target: 'darwin-arm64' })
  const entries = unzipSync(await readFile(variant.path))
  entries[DISTRIBUTION_TARGET_FILE] = strToU8(JSON.stringify({ schemaVersion: 1, target: 'win32-x64' }))
  assert.throws(() => archiveMetadata(zipSync(entries), undefined, { target: 'win32-x64' }), /disagree/)
  entries[DISTRIBUTION_TARGET_FILE] = strToU8(JSON.stringify({ schemaVersion: 1, target: 'darwin-arm64' }))
  delete entries[`backend/node_modules/${f.names[0]}/package.json`]
  assert.throws(() => archiveMetadata(zipSync(entries), undefined, { target: 'darwin-arm64' }), /missing package/)
})

test('target label cannot hide native variants for another platform', () => {
  const inventory = { target: 'win32-x64', supportedTargets: ['win32-x64'], nativePackages: [{ name: '@fixture/native-darwin-arm64' }] }
  assert.throws(() => resolveDistributionTarget(undefined, inventory), /incompatible/)
  assert.throws(() => resolveDistributionTarget(undefined, { ...inventory, target: 'universal' }), /missing win32-x64/)
})

test('private runtime is generic to declared backends and still rejects nested symbolic links', async t => {
  const f = await fixture(t)
  const privateFile = 'runtime/node_modules/fixture-runtime/src/value.ts'
  await mkdir(join(f.dist, privateFile, '..'), { recursive: true })
  await writeFile(join(f.dist, privateFile), 'export const privateRuntime = true')
  await validateDistribution(f.dist)
  const archive = await packPlugin('native', { repositoryRoot: f.root, build: false })
  assert.equal(archiveMetadata(await readFile(archive.path)).manifest.id, 'com.github.eNest.native')
  await symlink(join(f.dist, privateFile), join(f.dist, 'runtime/linked.ts'))
  await assert.rejects(validateDistribution(f.dist), /Symlink forbidden/)
  const portable = join(f.root, 'plugins/portable/dist')
  await mkdir(join(portable, 'runtime'), { recursive: true })
  await writeFile(join(portable, 'runtime/entry.js'), 'module.exports = 1')
  await assert.rejects(validateDistribution(portable), /outside distribution contract/)
  const entries = unzipSync(await readFile(archive.path))
  const manifest = JSON.parse(strFromU8(entries['plugin.json']))
  delete manifest.backend
  entries['plugin.json'] = strToU8(JSON.stringify(manifest))
  assert.throws(() => archiveMetadata(zipSync(entries)), /runtime requires a declared plugin backend/)
})

test('real target DuckDB addon loads locally without opening a database or connection', { skip: !process.env.ENEST_NATIVE_DISTRIBUTION }, async () => {
  const directory = process.env.ENEST_NATIVE_DISTRIBUTION
  assert.equal(await readDistributionTarget(directory), `${process.platform}-${process.arch}`)
  const require = createRequire(join(directory, 'backend/index.cjs'))
  const nativePath = require.resolve(`@duckdb/node-bindings-${process.platform}-${process.arch}/duckdb.node`)
  assert.ok(nativePath.startsWith(join(directory, 'backend/node_modules') + '/'))
  assert.equal(typeof require('@duckdb/node-api').DuckDBInstance, 'function')
})
