import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync } from 'fflate'
import { validateManifest as validateSdkManifest } from '../packages/plugin-sdk/src/validate.mjs'
import { buildPlugin } from './build-plugin.mjs'
import { archiveMetadata } from './build-registry.mjs'
import { validateSource } from './validate-manifests.mjs'
import { validateDistribution } from './validate-dist.mjs'

async function fixture(t) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'enest-home-contract-'))
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }))
  const directory = join(repositoryRoot, 'plugins', 'hometest')
  const source = 'com.github.eNest.hometest'
  const home = { source, id: 'dashboard', version: 1, entry: 'homes/dashboard.html', variants: ['studio', 'library'] }
  const manifest = {
    id: source, name: 'Home fixture', version: '1.0.0', description: 'Local fixture', main: 'index.html', icon: 'assets/market/icon.svg',
    market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/01-main.png'] },
    contributes: { homePages: [home] }
  }
  const files = {
    'plugin.json': JSON.stringify(manifest),
    'package.json': JSON.stringify({ name: 'hometest', version: '1.0.0', type: 'module' }),
    'index.html': '<!doctype html><script type="module" src="./src/main.js"></script>',
    'homes/dashboard.html': '<!doctype html><script type="module" src="../src/home.js"></script>',
    'src/main.js': 'document.body.dataset.business="loaded"',
    'src/home.js': 'const workspace=window.enestWorkspace;workspace.onCommand(command=>{if(command.type==="navigate")void workspace.ackNavigation({requestId:command.requestId,generation:command.generation,ok:true})});workspace.ready({workspaceVersion:1,routes:["catalog","installed","detail","settings"]})',
    'public/assets/market/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'public/assets/market/README.md': '# Home fixture',
    'public/assets/market/screenshots/01-main.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jStsAAAAASUVORK5CYII=', 'base64')
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, '..'), { recursive: true })
    await writeFile(join(directory, path), content)
  }
  return { repositoryRoot, directory, manifest, home }
}

test('SDK/CLI reject forged, duplicate, traversing and remote Home declarations', async t => {
  const f = await fixture(t)
  assert.deepEqual(await validateSdkManifest(f.manifest), { ok: true, errors: [] })
  for (const home of [
    { ...f.home, source: 'com.other.plugin' },
    { ...f.home, entry: '../private.html' },
    { ...f.home, entry: 'https://example.com/home.html' },
    { ...f.home, variants: ['studio', 'studio'] }
  ]) assert.equal((await validateSdkManifest({ ...f.manifest, contributes: { homePages: [home] } })).ok, false)
  assert.equal((await validateSdkManifest({ ...f.manifest, contributes: { homePages: [f.home, f.home] } })).ok, false)
  assert.deepEqual(validateSource(f.directory), [])
  await rm(join(f.directory, f.home.entry))
  assert.match(validateSource(f.directory).join('\n'), /ENOENT|Expected a file/)
})

test('manifest V2 themes and Home declarations accept the exact official mixed-case source', async t => {
  const f = await fixture(t)
  const variant = {
    tokens: { '--accent': '#315d4c' }, fonts: { body: 'Georgia', heading: 'Georgia', mono: 'monospace', scale: 1 },
    components: { controlRadius: 6, cardRadius: 10, panelRadius: 12, borderWidth: 1 },
    background: { media: null, effect: 'none', texture: 'none', intensity: 0, speed: 1, direction: 0 },
    layout: { variant: 'studio', density: 1, gap: 12, sidebarWidth: 260, contentWidth: 900, columns: 2 }, animation: 'medium'
  }
  f.manifest.contributes.themePacks = [{
    schemaVersion: 2, version: 1, id: 'official', name: 'Official', mode: 'system', source: f.manifest.id,
    variants: { light: variant, dark: variant },
    home: { source: f.manifest.id, id: f.home.id, variant: 'studio' },
    settings: { version: 2, groups: [{ id: 'main', title: 'Main', fields: [{ key: 'accent', label: 'Accent', type: 'color', default: '#315d4c', binding: { target: 'token', key: '--accent' } }] }] }
  }]
  await writeFile(join(f.directory, 'plugin.json'), JSON.stringify(f.manifest))
  assert.deepEqual(await validateSdkManifest(f.manifest), { ok: true, errors: [] })
  assert.deepEqual(validateSource(f.directory), [])
  const forged = structuredClone(f.manifest)
  forged.contributes.homePages[0].source = f.manifest.id.toLowerCase()
  assert.equal((await validateSdkManifest(forged)).ok, false, 'source equality remains case-sensitive')
})

test('declared Home pages survive the actual multi-page build and validated release archive', async t => {
  const f = await fixture(t)
  const distribution = await buildPlugin('hometest', { repositoryRoot: f.repositoryRoot, runtime: false })
  assert.match(await readFile(join(distribution, 'index.html'), 'utf8'), /assets\/app\//)
  const homeHtml = await readFile(join(distribution, 'homes/dashboard.html'), 'utf8')
  assert.match(homeHtml, /\.\.\/assets\/app\//)
  await validateDistribution(distribution, { requireRuntime: false })
  const entries = {}
  async function collect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`
      if (entry.isDirectory()) await collect(join(directory, entry.name), `${name}/`)
      else entries[name] = await readFile(join(directory, entry.name))
    }
  }
  await collect(distribution)
  assert.equal(archiveMetadata(zipSync(entries)).manifest.contributes.homePages[0].entry, f.home.entry)
  const missing = { ...entries }
  delete missing[f.home.entry]
  assert.throws(() => archiveMetadata(zipSync(missing)), /Declared home entry missing/)
  assert.throws(() => archiveMetadata(zipSync({ ...entries, 'homes/unlisted.html': Buffer.from('unlisted') })), /Invalid archive entry/)
  await writeFile(join(distribution, 'homes/unlisted.html'), 'unlisted')
  await assert.rejects(validateDistribution(distribution), /File outside distribution contract/)
})
