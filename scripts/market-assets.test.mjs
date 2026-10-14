import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { buildRegistry, archiveMetadata } from './build-registry.mjs'
import { prepareRelease } from './prepare-release.mjs'
import { validateSource } from './validate-manifests.mjs'
import { validateDistribution } from './validate-dist.mjs'
import { validPath } from './plugin-contract.mjs'
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jStsAAAAASUVORK5CYII=', 'base64')
function fixture(t) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'enest-standard-'))
  t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }))
  const manifest = { id: 'com.example.test', name: 'Test', version: '1.0.0', description: 'Fixture', main: 'index.html', icon: 'assets/market/icon.svg', market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/01-main.png'] } }
  const pluginDir = join(repositoryRoot, 'plugins', manifest.id), entries = {
    'plugin.json': strToU8(JSON.stringify(manifest)), 'index.html': strToU8('<p>Fixture</p>'),
    'assets/market/icon.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'assets/market/README.md': strToU8('# Package description\n![screen](./screenshots/01-main.png)'),
    'assets/market/screenshots/01-main.png': image
  }
  mkdirSync(join(repositoryRoot, 'dist'), { recursive: true }); mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest))
  function archive() { writeFileSync(join(repositoryRoot, 'dist', `${manifest.id}@${manifest.version}.enestplugin`), zipSync(entries)) }
  function source() {
    writeFileSync(join(pluginDir, 'index.html'), '<p>Source</p>')
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: manifest.id, version: manifest.version, type: 'module' }))
    for (const [path, value] of Object.entries(entries)) if (path.startsWith('assets/')) { const file = join(pluginDir, 'public', path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, value) }
  }
  archive(); source(); return { repositoryRoot, pluginDir, manifest, entries, archive }
}
test('strict source contract rejects legacy layout and validates public market resources', t => {
  const f = fixture(t); assert.deepEqual(validateSource(f.pluginDir), [])
  writeFileSync(join(f.pluginDir, 'icon.svg'), 'legacy')
  assert.match(validateSource(f.pluginDir).join('\n'), /Legacy/)
})
test('registry metadata is extracted from final archives, independent of source content', t => {
  const f = fixture(t)
  writeFileSync(join(f.pluginDir, 'public/assets/market/README.md'), 'Different source text')
  const registry = buildRegistry(f.repositoryRoot), item = registry.plugins[0]
  assert.equal(item.icon, 'com.example.test%401.0.0/assets/market/icon.svg')
  assert.match(readFileSync(join(f.repositoryRoot, 'dist/com.example.test@1.0.0/assets/market/README.md'), 'utf8'), /Package description/)
  assert.ok(item.asset.size > 0); assert.match(item.asset.sha256, /^[0-9a-f]{64}$/)
})
test('package paths reject traversal, hidden names, schemes and encoded separators', () => {
  for (const path of ['../a', '/a', 'a//b', 'a/./b', 'a/.secret', 'https:x', 'a\\b', 'a%2fb', 'a?x', 'a#x']) assert.equal(validPath(path), false, path)
  assert.equal(validPath('assets/market/screenshots/01-main.png'), true)
  assert.equal(validPath('assets/market/screenshots/主界面 1.PNG'), true)
})
test('source and archive accept Unicode, spaces and uppercase screenshot extensions', t => {
  const f = fixture(t), path = 'assets/market/screenshots/主界面 1.PNG'
  f.manifest.market.screenshots = [path]
  f.entries[path] = image
  f.entries['plugin.json'] = strToU8(JSON.stringify(f.manifest))
  f.entries['assets/market/README.md'] = strToU8('![Main](<./screenshots/主界面 1.PNG>)')
  writeFileSync(join(f.pluginDir, 'plugin.json'), JSON.stringify(f.manifest))
  writeFileSync(join(f.pluginDir, 'public', path), image)
  assert.deepEqual(validateSource(f.pluginDir), [])
  assert.deepEqual(archiveMetadata(zipSync(f.entries)).manifest.market.screenshots, [path])
  f.archive()
  const item = prepareRelease({ repositoryRoot: f.repositoryRoot, repository: 'owner/plugins', tag: 'v1' }).plugins[0]
  assert.equal(item.readmeImages['./screenshots/主界面 1.PNG'], item.screenshots[0])
  assert.match(item.screenshots[0], /screenshot-1.png$/)
})
test('source images must be regular in-root files without symlinks', t => {
  const f = fixture(t), imagePath = join(f.pluginDir, 'public/assets/market/screenshots/01-main.png')
  rmSync(imagePath); symlinkSync(join(f.pluginDir, 'index.html'), imagePath)
  assert.match(validateSource(f.pluginDir).join('\n'), /[Ss]ymlink|Symbolic/)
})
test('archive rejects missing market files, unpublished dev settings and extra roots', t => {
  const f = fixture(t)
  delete f.entries['assets/market/screenshots/01-main.png']
  assert.throws(() => archiveMetadata(zipSync(f.entries)), /missing required/)
  f.entries['assets/market/screenshots/01-main.png'] = image
  f.entries['.env'] = strToU8('secret')
  assert.throws(() => archiveMetadata(zipSync(f.entries)), /Invalid archive/)
  delete f.entries['.env']; f.entries['plugin.json'] = strToU8(JSON.stringify({ ...f.manifest, development: { main: 'http://localhost:5173/' } }))
  assert.throws(() => archiveMetadata(zipSync(f.entries)), /development/)
})
test('distribution validation catches missing local scripts and development source', async t => {
  const f = fixture(t), directory = join(f.pluginDir, 'dist')
  for (const [path, value] of Object.entries(f.entries)) { const file = join(directory, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, value) }
  await validateDistribution(directory)
  writeFileSync(join(directory, 'index.html'), '<script type="module" src="assets/missing.js"></script>')
  await assert.rejects(validateDistribution(directory), /missing local resource/)
})
test('Release media attachments come from archives and match versioned URLs', t => {
  const f = fixture(t), result = prepareRelease({ repositoryRoot: f.repositoryRoot, repository: 'owner/plugins', tag: 'v1.0.0' })
  const item = result.plugins[0]
  assert.match(item.icon, /com.example.test%401.0.0-icon.svg$/)
  assert.deepEqual(readFileSync(join(f.repositoryRoot, 'dist/com.example.test@1.0.0-screenshot-1.png')), image)
  assert.match(item.readmeUrl, /com.example.test%401.0.0-README.md$/)
  assert.equal(item.readmeImages['./screenshots/01-main.png'], item.screenshots[0])
})
test('missing archive cannot publish a registry', t => {
  const f = fixture(t); rmSync(join(f.repositoryRoot, 'dist/com.example.test@1.0.0.enestplugin'))
  assert.throws(() => buildRegistry(f.repositoryRoot), /ENOENT/)
})

test('archives reject missing entry points, foreign runtimes, source leakage and oversized README', t => {
  const f = fixture(t)
  const without = { ...f.entries }; delete without['index.html']
  assert.throws(() => archiveMetadata(zipSync(without)), /no index.html/)
  assert.throws(() => archiveMetadata(zipSync({ ...f.entries, 'runtime/a': strToU8('runtime') })), /only permitted for DSH/)
  assert.throws(() => archiveMetadata(zipSync({ ...f.entries, 'assets/app/secret.ts': strToU8('source') })), /Development file/)
  assert.throws(() => archiveMetadata(zipSync({ ...f.entries, 'assets/market/README.md': new Uint8Array(512 * 1024 + 1) })), /README exceeds/)
  writeFileSync(join(f.pluginDir, 'public/assets/market/README.md'), Buffer.alloc(512 * 1024 + 1))
  assert.match(validateSource(f.pluginDir).join('\n'), /README exceeds/)
})
