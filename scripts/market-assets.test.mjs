import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { buildRegistry } from './build-registry.mjs'
import { prepareRelease } from './prepare-release.mjs'
import { validateAllManifests } from './validate-manifests.mjs'

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jStsAAAAASUVORK5CYII=', 'base64')

function fixture(t, extra = {}) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'enest-market-'))
  t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }))
  const manifest = {
    id: 'com.example.test', name: 'Test', version: '1.0.0',
    description: 'Metadata test fixture', main: 'index.html', ...extra
  }
  const pluginDir = join(repositoryRoot, 'plugins', manifest.id)
  mkdirSync(join(pluginDir, 'assets', 'screenshots'), { recursive: true })
  const writeManifest = () => writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest))
  writeManifest()
  return { repositoryRoot, pluginDir, manifest, writeManifest }
}

test('old manifests keep empty media and featured defaults', (t) => {
  const { repositoryRoot } = fixture(t)
  const plugin = buildRegistry(repositoryRoot).plugins[0]
  assert.deepEqual(plugin.screenshots, [])
  assert.equal(plugin.featured, false)
  assert.equal(plugin.icon, '')
})

test('local registry preserves screenshot order and resolves plugin-relative paths', (t) => {
  const { repositoryRoot, pluginDir } = fixture(t, {
    market: { featured: true, screenshots: ['assets/screenshots/主界面 1.png', 'https://cdn.example.com/preview?id=2'] }
  })
  writeFileSync(join(pluginDir, 'assets/screenshots/主界面 1.png'), image)
  const plugin = buildRegistry(repositoryRoot).plugins[0]
  assert.equal(plugin.featured, true)
  assert.deepEqual(plugin.screenshots, [
    'plugins/com.example.test/assets/screenshots/%E4%B8%BB%E7%95%8C%E9%9D%A2%201.png',
    'https://cdn.example.com/preview?id=2'
  ])
})

test('invalid screenshot metadata fails validation and registry generation', async (t) => {
  const invalid = [
    ['../outside.png', /relative to the plugin root/],
    ['/tmp/image.png', /relative to the plugin root/],
    ['assets\\image.png', /relative to the plugin root/],
    ['http://cdn.example.com/image.png', /relative to the plugin root/],
    ['file:///tmp/image.png', /relative to the plugin root/],
    ['https://user:pass@example.com/image.png', /credentials/],
    ['assets/screenshots/missing.png', /file does not exist/],
    ['assets/screenshots/image.svg', /must use/],
    ['', /must NOT have fewer/]
  ]
  for (const [value, expected] of invalid) {
    await t.test(value || 'empty screenshot', (t) => {
      const { repositoryRoot } = fixture(t, { market: { screenshots: [value] } })
      assert.match(validateAllManifests(repositoryRoot).join('\n'), expected)
      assert.throws(() => buildRegistry(repositoryRoot), expected)
    })
  }
})

test('screenshot count, duplicate entries and element types follow the schema', (t) => {
  const { repositoryRoot, manifest, writeManifest } = fixture(t)
  for (const screenshots of [
    Array.from({ length: 9 }, (_, i) => `https://cdn.example.com/${i}.png`),
    ['https://cdn.example.com/a.png', 'https://cdn.example.com/a.png'],
    [123], 'assets/image.png'
  ]) {
    manifest.market = { screenshots }
    writeManifest()
    assert.notEqual(validateAllManifests(repositoryRoot).length, 0)
  }
})

test('local screenshot must be a regular file within its plugin root', (t) => {
  const { repositoryRoot, pluginDir, manifest, writeManifest } = fixture(t)
  mkdirSync(join(pluginDir, 'directory.png'))
  manifest.market = { screenshots: ['directory.png'] }
  writeManifest()
  assert.match(validateAllManifests(repositoryRoot).join('\n'), /regular file/)
  const outside = join(repositoryRoot, 'outside.png')
  writeFileSync(outside, image)
  symlinkSync(outside, join(pluginDir, 'escaped.png'))
  manifest.market.screenshots = ['escaped.png']
  writeManifest()
  assert.match(validateAllManifests(repositoryRoot).join('\n'), /inside the plugin root/)
})

test('manifest versions cannot create attachment paths outside dist', (t) => {
  const { repositoryRoot, manifest, writeManifest } = fixture(t)
  manifest.version = '1.0.0-../../outside'
  writeManifest()
  assert.throws(() => buildRegistry(repositoryRoot), /version.*pattern/)
  manifest.version = '1.0.0-beta.1+build.2'
  writeManifest()
  assert.deepEqual(validateAllManifests(repositoryRoot), [])
})

test('release URLs match flattened media attachments and archive hashes', (t) => {
  const { repositoryRoot, pluginDir } = fixture(t, {
    logo: 'assets/brand.svg', icon: 'unused-fallback.png',
    market: { screenshots: ['assets/screenshots/cover.png', 'https://cdn.example.com/details.webp'] }
  })
  writeFileSync(join(pluginDir, 'assets/brand.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(pluginDir, 'assets/screenshots/cover.png'), image)
  const outDir = join(repositoryRoot, 'dist')
  mkdirSync(outDir)
  const archive = Buffer.from('archive fixture')
  writeFileSync(join(outDir, 'com.example.test@1.0.0.enestplugin'), archive)
  const registry = prepareRelease({ repositoryRoot, repository: 'org/plugins', tag: 'plugins-42' })
  const plugin = registry.plugins[0]
  assert.equal(plugin.icon, 'https://github.com/org/plugins/releases/download/plugins-42/com.example.test%401.0.0-icon.svg')
  assert.equal(plugin.screenshots[0], 'https://github.com/org/plugins/releases/download/plugins-42/com.example.test%401.0.0-screenshot-1.png')
  assert.equal(plugin.screenshots[1], 'https://cdn.example.com/details.webp')
  assert.deepEqual(readFileSync(join(outDir, 'com.example.test@1.0.0-screenshot-1.png')), image)
  for (const url of [plugin.icon, plugin.screenshots[0], plugin.asset.url]) {
    const filename = decodeURIComponent(new URL(url).pathname.split('/').at(-1))
    assert.ok(readFileSync(join(outDir, filename)).length)
  }
  assert.equal(plugin.asset.size, archive.length)
  assert.equal(plugin.asset.sha256, createHash('sha256').update(archive).digest('hex'))
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'registry.json'), 'utf-8')), registry)
})

test('missing archive cannot produce a release index with empty asset metadata', (t) => {
  const { repositoryRoot } = fixture(t)
  assert.throws(() => prepareRelease({ repositoryRoot, repository: 'org/plugins', tag: 'plugins-42' }), /ENOENT/)
})
