import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { archiveMetadata } from './build-registry.mjs'
import { pluginHtmlEntries } from './plugin-contract.mjs'
import { validateDistribution } from './validate-dist.mjs'
import { loadManifestValidator, validateManifest, validateSource } from './validate-manifests.mjs'

function themeManifest() {
  const variant = {
    tokens: {},
    fonts: { body: 'sans-serif', heading: 'sans-serif', mono: 'monospace', scale: 1 },
    components: { controlRadius: 4, cardRadius: 8, panelRadius: 8, borderWidth: 1 },
    background: { media: null, effect: 'none', texture: 'none', intensity: 0, speed: 1, direction: 0 },
    layout: { variant: 'classic', density: 1, gap: 8, sidebarWidth: 240, contentWidth: 1000, columns: 1 },
    animation: 'low'
  }
  return {
    id: 'com.github.eNest.chrome-fixture', name: 'Chrome fixture', version: '1.0.0',
    description: 'Targeted theme chrome distribution fixture', main: 'index.html',
    icon: 'assets/market/icon.svg', engines: { enest: '>=0.2.1' },
    market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/01-main.png'] },
    contributes: {
      homePages: [{ id: 'workspace', source: 'com.github.eNest.chrome-fixture', version: 1, entry: 'home/workspace.html', variants: ['classic'] }],
      themePacks: [{ id: 'fixture', name: 'Fixture', schemaVersion: 2, version: 1,
        variants: { light: variant, dark: variant }, settings: { version: 1, groups: [] },
        quick: { version: 1, entry: 'quick/search.html' },
        chrome: { version: 1, classic: { entry: 'chrome/tabs.html' }, rail: { entry: 'chrome/rail.html' }, dock: { entry: 'chrome/dock.html' } }
      }]
    }
  }
}

async function write(directory, path, value) {
  const file = join(directory, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, value)
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'enest-chrome-distribution-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), dist = join(root, 'dist'), manifest = themeManifest()
  const entries = {
    'plugin.json': strToU8(JSON.stringify(manifest)),
    'assets/market/icon.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'),
    'assets/market/README.md': strToU8('# Fixture\n'),
    'assets/market/screenshots/01-main.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT2kAAAAASUVORK5CYII=', 'base64'),
    'assets/vendor/chrome.js': strToU8('export const chromeFixture = true\n')
  }
  for (const entry of pluginHtmlEntries(manifest)) {
    const prefix = entry === 'index.html' ? './' : '../'
    entries[entry] = strToU8(`<!doctype html><meta charset="utf-8"><script type="module" src="${prefix}assets/vendor/chrome.js"></script>`)
  }
  for (const [path, value] of Object.entries(entries)) {
    await write(dist, path, value)
    await write(source, path.startsWith('assets/') ? `public/${path}` : path, value)
  }
  await write(source, 'package.json', JSON.stringify({ name: 'chrome-fixture', version: manifest.version, type: 'module' }))
  return { source, dist, manifest, entries }
}

test('HTML entry enumeration includes all V2 chrome surfaces and deduplicates shared pages', () => {
  const manifest = themeManifest()
  assert.deepEqual(pluginHtmlEntries(manifest), ['index.html', 'home/workspace.html', 'quick/search.html', 'chrome/tabs.html', 'chrome/rail.html', 'chrome/dock.html'])
  manifest.contributes.themePacks.push({ schemaVersion: 2, quick: { entry: 'index.html' }, chrome: { classic: { entry: 'chrome/tabs.html' } } })
  manifest.contributes.themePacks.push({ schemaVersion: 1, quick: { entry: 'legacy/quick.html' }, chrome: { classic: { entry: 'legacy/tabs.html' } } })
  assert.deepEqual(pluginHtmlEntries(manifest), ['index.html', 'home/workspace.html', 'quick/search.html', 'chrome/tabs.html', 'chrome/rail.html', 'chrome/dock.html'])
  assert.deepEqual(pluginHtmlEntries({}), ['index.html'])
})

test('source, distribution and final archive accept declared chrome pages alongside home and Quick', async t => {
  const f = await fixture(t)
  assert.deepEqual(validateSource(f.source), [])
  assert.equal((await validateDistribution(f.dist)).id, f.manifest.id)
  const archive = archiveMetadata(zipSync(f.entries), f.manifest)
  assert.deepEqual(archive.manifest.contributes.themePacks[0].chrome, f.manifest.contributes.themePacks[0].chrome)
})

test('each declared classic, rail and dock page is required by every packaging validation boundary', async t => {
  const f = await fixture(t)
  for (const surface of ['classic', 'rail', 'dock']) {
    const entry = f.manifest.contributes.themePacks[0].chrome[surface].entry
    await rm(join(f.source, entry))
    await rm(join(f.dist, entry))
    assert.ok(validateSource(f.source).some(error => error.includes(entry)))
    await assert.rejects(validateDistribution(f.dist), error => error.message.includes(entry))
    const entries = { ...f.entries }
    delete entries[entry]
    assert.throws(() => archiveMetadata(zipSync(entries), f.manifest), error => error.message.includes(entry))
    await write(f.source, entry, f.entries[entry])
    await write(f.dist, entry, f.entries[entry])
  }
})

test('declaring chrome does not authorize undeclared sibling HTML in distributions or archives', async t => {
  const f = await fixture(t), entry = 'chrome/undeclared.html'
  await write(f.dist, entry, '<!doctype html>')
  await assert.rejects(validateDistribution(f.dist), /File outside distribution contract: chrome\/undeclared\.html/)
  assert.throws(() => archiveMetadata(zipSync({ ...f.entries, [entry]: strToU8('<!doctype html>') }), f.manifest), /Invalid archive entry: chrome\/undeclared\.html/)
})

test('chrome entries cannot use private directories, traversal, remote URLs or symbolic links', async t => {
  const validator = loadManifestValidator()
  for (const entry of ['../outside.html', '/absolute.html', 'https://example.test/tabs.html', 'backend/index.html', 'runtime/tabs.html', 'node_modules/tabs.html', 'src/tabs.html', 'test/tabs.html', 'tests/tabs.html', 'chrome/runtime/tabs.html']) {
    const manifest = themeManifest()
    manifest.contributes.themePacks[0].chrome.classic.entry = entry
    assert.notDeepEqual(validateManifest(validator, manifest, manifest.id), [], entry)
  }
  const f = await fixture(t), entry = 'chrome/tabs.html'
  for (const directory of [f.source, f.dist]) {
    await rm(join(directory, entry))
    await symlink(join(directory, 'index.html'), join(directory, entry))
  }
  assert.ok(validateSource(f.source).some(error => error.includes('Symbolic links are not allowed')))
  await assert.rejects(validateDistribution(f.dist), /Symbolic links are not allowed/)
})
