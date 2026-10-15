import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBackend, validateNativeArchive } from './build-backend.mjs'
import { validBackendPath } from './plugin-contract.mjs'

async function fixture(t, { dependencies = ['fixture-driver'], platformPackages = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'enest backend # fixture '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'plugins/com.fixture.backend'), destination = join(source, 'dist')
  await mkdir(join(source, 'backend'), { recursive: true })
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ backend: { entry: 'backend/index.cjs' }, permissions: ['backend.node'] }))
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'com.fixture.backend', dependencies: Object.fromEntries(dependencies.map(name => [name, '1.0.0'])), enestBackend: { entry: 'backend/index.js', dependencies, platformPackages } }))
  await writeFile(join(source, 'backend/index.js'), dependencies.length ? `module.exports = require('${dependencies[0]}')` : 'module.exports = 42')
  const lock = { lockfileVersion: 3, packages: {} }
  const addPackage = async (name, pkg = {}, files = { 'index.js': 'module.exports = 42' }, location = `node_modules/${name}`) => {
    const dir = join(root, location)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }))
    for (const [file, contents] of Object.entries(files)) { await mkdir(join(dir, file, '..'), { recursive: true }); await writeFile(join(dir, file), contents) }
    lock.packages[location] = { version: pkg.version || '1.0.0' }
  }
  const saveLock = () => writeFile(join(root, 'package-lock.json'), JSON.stringify(lock))
  return { root, source, destination, lock, addPackage, saveLock }
}

test('isolated backend preserves transitive imports, nested versions, runtime src/data, and legal # filenames', async t => {
  const f = await fixture(t)
  await f.addPackage('fixture-driver', { dependencies: { 'fixture-transitive': '1.0.0' } }, {
    'index.js': "module.exports = require('./src/value#one.js') + require('fixture-transitive')",
    'src/value#one.js': "module.exports = require('./data.json').value", 'src/data.json': '{"value":7}', LICENSE: 'license'
  })
  await f.addPackage('fixture-transitive', {}, { 'index.js': 'module.exports = 11' }, 'node_modules/fixture-driver/node_modules/fixture-transitive')
  await f.saveLock()
  await buildBackend(f.source, f.destination, { root: f.root })
  const require = createRequire(join(f.root, 'isolated.cjs'))
  assert.equal(require(join(f.destination, 'backend/index.cjs')), 18)
  assert.equal(validBackendPath('backend/node_modules/fixture-driver/src/value#one.js'), true)
  await access(join(f.destination, 'backend/node_modules/fixture-driver/LICENSE'))
  assert.equal(JSON.parse(await readFile(join(f.destination, 'backend/dependency-inventory.json'))).dependencies.length, 2)
})

test('backend rejects installed dependencies that disagree with the lockfile', async t => {
  const f = await fixture(t)
  await f.addPackage('fixture-driver')
  f.lock.packages['node_modules/fixture-driver'].version = '2.0.0'
  await f.saveLock()
  await assert.rejects(buildBackend(f.source, f.destination, { root: f.root }), /does not match lockfile/)
})

async function cachedNative(f, name, marker) {
  const cache = join(f.root, 'dist/backend-cache', name.replaceAll('/', '-'), '1.0.0')
  const content = join(f.root, 'tar-input', name.replaceAll('/', '-'))
  await mkdir(join(content, 'package'), { recursive: true })
  await writeFile(join(content, 'package/package.json'), JSON.stringify({ name, version: '1.0.0' }))
  await writeFile(join(content, 'package/duckdb.node'), marker)
  await writeFile(join(content, 'package/LICENSE'), 'MIT native notice')
  await mkdir(cache, { recursive: true })
  const archive = join(cache, 'package.tgz')
  execFileSync('tar', ['-czf', archive, '-C', content, 'package'])
  f.lock.packages[`node_modules/${name}`] = { version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/fixture-1.0.0.tgz`, integrity: `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}` }
  return { archive, content }
}

test('one offline plugin build includes all four locked native platform packages independent of host', async t => {
  const names = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'].map(platform => `@duckdb/node-bindings-${platform}`)
  const f = await fixture(t, { dependencies: [], platformPackages: names })
  for (const name of names) await cachedNative(f, name, `binary for ${name}`)
  await f.saveLock()
  await buildBackend(f.source, f.destination, { root: f.root })
  for (const name of names) {
    assert.equal(await readFile(join(f.destination, 'backend/node_modules', name, 'duckdb.node'), 'utf8'), `binary for ${name}`)
    await access(join(f.destination, 'backend/node_modules', name, 'LICENSE'))
  }
  const inventory = JSON.parse(await readFile(join(f.destination, 'backend/dependency-inventory.json')))
  assert.equal(inventory.nativePackages.length, 4)
  assert.ok(inventory.nativePackages.every(pkg => pkg.version === '1.0.0' && pkg.integrity.startsWith('sha512-')))
})

test('native cache integrity and installed native identity are checked before copying', async t => {
  const name = '@duckdb/node-bindings-darwin-arm64'
  const f = await fixture(t, { dependencies: [], platformPackages: [name] })
  const { archive } = await cachedNative(f, name, 'fixture')
  await f.saveLock()
  await writeFile(archive, 'corrupt archive')
  await assert.rejects(buildBackend(f.source, f.destination, { root: f.root }), /integrity mismatch/)
  await f.addPackage(name, { version: '2.0.0' })
  // The saved lock remains pinned to 1.0.0.
  await assert.rejects(buildBackend(f.source, f.destination, { root: f.root }), /identity mismatch/)
})

test('native archive links are rejected before extraction even when entry names stay under package/', async t => {
  const f = await fixture(t, { dependencies: [] })
  const name = '@duckdb/node-bindings-linux-x64'
  const { archive, content } = await cachedNative(f, name, 'fixture')
  await symlink(f.root, join(content, 'package/outside'))
  execFileSync('tar', ['-czf', archive, '-C', content, 'package'])
  assert.throws(() => validateNativeArchive(archive), /Unsafe native package archive entry type/)
})

test('pack CLI executes from directories containing spaces and # instead of silently skipping its entrypoint', async t => {
  const f = await fixture(t, { dependencies: [] })
  const scripts = join(f.root, 'scripts')
  await mkdir(scripts)
  await cp(new URL('./pack-plugin.mjs', import.meta.url), join(scripts, 'pack-plugin.mjs'))
  await writeFile(join(scripts, 'build-plugin.mjs'), 'export const buildPlugin=()=>{throw new Error("unexpected build")}')
  await writeFile(join(scripts, 'validate-dist.mjs'), 'export const validateDistribution=async()=>{}')
  await writeFile(join(scripts, 'plugin-contract.mjs'), `export const repositoryRoot=${JSON.stringify(f.root)}; export const pluginIds=()=>['com.fixture.backend'];export const readManifest=()=>({id:'com.fixture.backend',version:'1.0.0'}); export const DSH_ID='com.enest.dsh', DSH_VERSION='test';`)
  await mkdir(f.destination, { recursive: true })
  await writeFile(join(f.destination, 'index.html'), 'fixture')
  const output = execFileSync(process.execPath, [join(scripts, 'pack-plugin.mjs'), 'com.fixture.backend', '--no-build'], { encoding: 'utf8' })
  assert.equal(JSON.parse(output).name, 'com.fixture.backend@1.0.0.enestplugin')
  await access(join(f.root, 'dist/com.fixture.backend@1.0.0.enestplugin'))
})
