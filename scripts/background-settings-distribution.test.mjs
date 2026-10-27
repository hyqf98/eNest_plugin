import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { archiveMetadata } from './build-registry.mjs'
import { pluginHtmlEntries } from './plugin-contract.mjs'
import { validateDistribution } from './validate-dist.mjs'
import { loadManifestValidator, validateManifest, validateSource } from './validate-manifests.mjs'

// Temporary package fixtures only; no installed plugins, native runtime or network.
function manifestFixture() {
  const variant = {
    tokens: {}, fonts: { body: 'sans-serif', heading: 'sans-serif', mono: 'monospace', scale: 1 },
    components: { controlRadius: 4, cardRadius: 8, panelRadius: 8, borderWidth: 1 },
    background: { media: null, effect: 'none', texture: 'none', intensity: 0, speed: 1, direction: 0 },
    layout: { variant: 'fixture', density: 1, gap: 8, sidebarWidth: 240, contentWidth: 1000, columns: 1 },
    animation: 'low'
  }
  return {
    id: 'com.github.eNest.background-settings-fixture', name: 'Background settings fixture', version: '1.0.0',
    description: 'Targeted background and settings HTML distribution fixture', main: 'index.html',
    icon: 'assets/market/icon.svg', engines: { enest: '>=0.2.3' },
    market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/01-main.png'] },
    background: { entry: 'assets/background.html', quickSearch: true },
    contributes: { themePacks: [{ id: 'fixture', name: 'Fixture', schemaVersion: 2, version: 1,
      variants: { light: variant, dark: variant }, settings: { version: 2, groups: [] },
      settingsPage: { version: 1, entry: 'assets/settings.html' }
    }] }
  }
}

async function write(directory, path, value) {
  const target = join(directory, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, value)
}

function html(entry, script) {
  const relative = posix.relative(posix.dirname(entry), script)
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="${relative.startsWith('.') ? relative : './' + relative}"></script></body></html>`
}

async function fixture(t) {
  const repository = await mkdtemp(join(tmpdir(), 'enest-background-settings-distribution-'))
  t.after(() => rm(repository, { recursive: true, force: true }))
  const manifest = manifestFixture(), id = manifest.id.split('.').pop()
  const source = join(repository, 'plugins', id), dist = join(repository, 'fixture-dist')
  const entries = {
    'plugin.json': strToU8(JSON.stringify(manifest)),
    'assets/market/icon.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'),
    'assets/market/README.md': strToU8('# Fixture\n'),
    'assets/market/screenshots/01-main.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT2kAAAAASUVORK5CYII=', 'base64'),
    'assets/app/fixture.js': strToU8('document.documentElement.dataset.fixture = "compiled"\n')
  }
  for (const entry of pluginHtmlEntries(manifest)) entries[entry] = strToU8(html(entry, 'assets/app/fixture.js'))
  for (const [path, bytes] of Object.entries(entries)) {
    await write(dist, path, bytes)
    if (path.startsWith('assets/market/')) await write(source, `public/${path}`, bytes)
  }
  await write(source, 'plugin.json', JSON.stringify(manifest))
  await write(source, 'package.json', JSON.stringify({ name: id, version: manifest.version, type: 'module' }))
  await write(source, 'vite.config.js', 'export default {}\n')
  for (const [index, entry] of pluginHtmlEntries(manifest).entries()) {
    await write(source, entry, html(entry, `src/entry-${index}.js`))
    await write(source, `src/entry-${index}.js`, `document.documentElement.dataset.fixture = "source-${index}"\n`)
  }
  return { repository, id, source, dist, manifest, entries }
}

test('declared background and V2 settings pages join the canonical Vite HTML inputs and deduplicate', () => {
  const manifest = manifestFixture()
  assert.deepEqual(pluginHtmlEntries(manifest), ['index.html', 'assets/background.html', 'assets/settings.html'])
  manifest.contributes.themePacks.push({ schemaVersion: 2, settingsPage: { entry: 'assets/background.html' } })
  manifest.contributes.themePacks.push({ schemaVersion: 1, settingsPage: { entry: 'assets/legacy.html' } })
  assert.deepEqual(pluginHtmlEntries(manifest), ['index.html', 'assets/background.html', 'assets/settings.html'])
})

test('minimal declared root assets HTML source builds into portable background and settings entries', async t => {
  const f = await fixture(t)
  assert.deepEqual(validateSource(f.source), [])
  const { buildPlugin } = await import('./build-plugin.mjs')
  const output = await buildPlugin(f.id, { repositoryRoot: f.repository, runtime: false })
  for (const entry of pluginHtmlEntries(f.manifest)) {
    const compiled = await readFile(join(output, entry), 'utf8')
    assert.match(compiled, /<script\b[^>]*\bsrc=["'][^"']*app\/[A-Za-z0-9_-]+\.js/)
    assert.doesNotMatch(compiled, /src\/entry-\d+\.js/)
  }
  assert.equal((await validateDistribution(output)).id, f.manifest.id)
})

test('a complete compiled fixture and final archive retain both declared entry kinds', async t => {
  const f = await fixture(t)
  assert.deepEqual(validateSource(f.source), [])
  assert.equal((await validateDistribution(f.dist)).id, f.manifest.id)
  const packaged = archiveMetadata(zipSync(f.entries), f.manifest).manifest
  assert.deepEqual(packaged.background, f.manifest.background)
  assert.deepEqual(packaged.contributes.themePacks[0].settingsPage, f.manifest.contributes.themePacks[0].settingsPage)
})

test('declared HTML does not permit undeclared assets HTML, scripts, media or legacy root files in source', async t => {
  const f = await fixture(t)
  for (const path of ['assets/undeclared.html', 'assets/extra.js', 'assets/icon.svg', 'assets/nested/extra.png']) {
    await write(f.source, path, 'fixture')
    assert.ok(validateSource(f.source).some(error => error.includes('Undeclared root asset:')), path)
    await rm(join(f.source, path))
    if (path.includes('/nested/')) await rm(join(f.source, 'assets/nested'), { recursive: true })
  }
  await write(f.source, 'settings.html', '<!doctype html>')
  assert.ok(validateSource(f.source).some(error => error.includes('Legacy root assets')), 'legacy root settings.html')
})

test('missing background or settings HTML is rejected in source, distribution and final archive', async t => {
  const f = await fixture(t)
  for (const entry of [f.manifest.background.entry, f.manifest.contributes.themePacks[0].settingsPage.entry]) {
    const source = await readFile(join(f.source, entry))
    await rm(join(f.source, entry))
    await rm(join(f.dist, entry))
    assert.ok(validateSource(f.source).some(error => error.includes(entry)), entry)
    await assert.rejects(validateDistribution(f.dist), error => error.message.includes(entry))
    const archive = { ...f.entries }
    delete archive[entry]
    assert.throws(() => archiveMetadata(zipSync(archive), f.manifest), error => error.message.includes(entry))
    await write(f.source, entry, source)
    await write(f.dist, entry, f.entries[entry])
  }
})

test('declared input symlinks and an undeclared sibling symlink are rejected without traversing them', async t => {
  const f = await fixture(t)
  for (const entry of [f.manifest.background.entry, f.manifest.contributes.themePacks[0].settingsPage.entry]) {
    for (const directory of [f.source, f.dist]) {
      await rm(join(directory, entry))
      await symlink(join(directory, 'index.html'), join(directory, entry))
    }
    assert.ok(validateSource(f.source).some(error => error.includes('Symbolic links are not allowed')), entry)
    await assert.rejects(validateDistribution(f.dist), /Symbolic links are not allowed/)
    for (const directory of [f.source, f.dist]) await rm(join(directory, entry))
    await write(f.source, entry, html(entry, 'src/entry-1.js'))
    await write(f.dist, entry, f.entries[entry])
  }
  await symlink(join(f.source, 'src'), join(f.source, 'assets/undeclared'))
  assert.ok(validateSource(f.source).some(error => error.includes('Symlink forbidden: assets/undeclared')))
})

test('settings and background entry declarations cannot bypass private-path and traversal restrictions', () => {
  const validator = loadManifestValidator()
  for (const entry of ['../outside.html', '/absolute.html', 'https://example.test/page.html', 'backend/page.html', 'assets/../page.html', 'src/page.html', 'tests/page.html']) {
    const background = manifestFixture()
    background.background.entry = entry
    assert.notDeepEqual(validateManifest(validator, background, background.id), [], `background ${entry}`)
    const settings = manifestFixture()
    settings.contributes.themePacks[0].settingsPage.entry = entry
    assert.notDeepEqual(validateManifest(validator, settings, settings.id), [], `settings ${entry}`)
  }
})

test('distribution reference validation rejects a missing compiled settings script', async t => {
  const f = await fixture(t), entry = f.manifest.contributes.themePacks[0].settingsPage.entry
  await write(f.dist, entry, html(entry, 'assets/app/missing.js'))
  await assert.rejects(validateDistribution(f.dist), /assets\/settings\.html: missing local resource/)
})
