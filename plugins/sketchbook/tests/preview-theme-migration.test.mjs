import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('plugin.json', root), 'utf8'))
const declared = manifest.contributes.themePacks.find(pack => pack.id === 'sketchbook')
let compiled

async function bundledPreview() {
  compiled ??= build({
    configFile: false,
    root: fileURLToPath(root),
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      target: 'chrome120',
      minify: false,
      lib: { entry: fileURLToPath(new URL('src/shared/previewTheme.js', root)), formats: ['es'] },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  }).then(async result => {
    const bundles = Array.isArray(result) ? result : [result]
    const chunks = bundles.flatMap(bundle => bundle.output).filter(output => output.type === 'chunk')
    assert.equal(chunks.length, 1, 'the fixture must contain the manifest without external module requests')
    const code = chunks[0].code
    assert.doesNotMatch(code, /\bfetch\s*\(/, 'the installed preview must not fetch root plugin.json')
    const api = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
    return { api, code }
  })
  return compiled
}

test('bundled preview loads the exact manifest theme without any network request', async () => {
  const { api } = await bundledPreview()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Installed package metadata is not a public asset') }
  try {
    assert.deepEqual(await api.loadPreviewTheme(), declared)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('bundled light and dark previews preserve their manifest tokens and palette declarations', async () => {
  const { api } = await bundledPreview()
  const pack = await api.loadPreviewTheme()
  for (const mode of ['light', 'dark']) {
    const appearance = api.createPreviewAppearance(pack, mode, 7)
    assert.equal(appearance.mode, mode)
    assert.equal(appearance.revision, 7)
    assert.deepEqual(appearance.tokens, { ...declared.tokens, ...declared.variants[mode].tokens })
    assert.deepEqual(appearance.fonts, declared.variants[mode].fonts)
    assert.deepEqual(appearance.components, declared.variants[mode].components)
  }
  assert.deepEqual(pack.palettes, declared.palettes)
})

test('workbench and browser preview use the bundled loader, while native workspace stays separate', async () => {
  const workbench = await readFile(new URL('src/index/entry.js', root), 'utf8')
  const preview = await readFile(new URL('src/market/mockBridge.js', root), 'utf8')
  const home = await readFile(new URL('src/market/home.js', root), 'utf8')
  for (const source of [workbench, preview]) {
    assert.match(source, /loadPreviewTheme\(\)/)
    assert.doesNotMatch(source, /new URL\([^\n]*plugin\.json/)
  }
  assert.doesNotMatch(home, /from\s+['"][^'"]*previewTheme/)
  assert.match(home, /wantMock && import\.meta\.env\?\.DEV \? await import\('\.\/mockBridge\.js'\)/)
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(manifest.version, pkg.version)
})
