import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { snapshotFor, appearanceCases } from './appearance-fixture.js'

const source = (await readFile(new URL('../../packages/plugin-kit/plugin-kit.js', import.meta.url), 'utf8'))
  .replace('export default PluginKit', '')
const css = await readFile(new URL('../../packages/plugin-kit/plugin-kit.css', import.meta.url), 'utf8')

function fixture(initial) {
  const properties = new Map(), frames = new Map(), listeners = new Set(), disposers = []
  let frameId = 0, unsubscribed = 0
  const root = { dataset: {}, style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) } }
  const main = { dataset: {} }
  const container = { dataset: {}, classList: { add() {} }, querySelectorAll: () => [main] }
  const document = {
    documentElement: root, readyState: 'loading', addEventListener() {},
    querySelector: selector => selector === '#root' ? container : null,
  }
  const window = {
    enest: {
      theme: {
        getAppearance: async () => initial,
        onAppearanceChange: callback => { listeners.add(callback); return () => { listeners.delete(callback); unsubscribed++ } },
      },
      onDestroy: callback => disposers.push(callback),
    },
    dispatchEvent() {},
  }
  vm.runInNewContext(source, {
    window, document, location: { search: '', pathname: '/plugins/fixture/index.html' }, URLSearchParams,
    requestAnimationFrame: callback => { const id = ++frameId; frames.set(id, callback); return id },
    cancelAnimationFrame: id => frames.delete(id),
    MutationObserver: class { observe() {} }, Event: class { constructor(type) { this.type = type } },
    setTimeout, clearTimeout, Promise,
  })
  const adapter = window.PluginKit.useAppearanceLayout({ plugin: 'fixture', family: 'editor', regions: { main: 'textarea' } })
  return { root, main, container, adapter, properties, frames, emit: value => { for (const callback of listeners) callback(value) },
    destroy: () => disposers.forEach(callback => callback()), get unsubscribed() { return unsubscribed } }
}

test('appearance fixtures cover only the host default and an independent third-party contract', () => {
  assert.deepEqual(appearanceCases, ['default', 'contract'])
  for (const mode of ['light', 'dark']) {
    const builtin = snapshotFor('default', mode, 1), extension = snapshotFor('contract', mode, 2)
    assert.equal(builtin.theme.source, 'enest.builtin')
    assert.equal(builtin.theme.id, 'default')
    assert.equal(builtin.layout.variant, 'default')
    assert.equal(extension.theme.source, 'com.example.appearance.contract')
    assert.equal(extension.theme.id, 'contract-theme')
    assert.equal(extension.layout.variant, 'studio-board')
    assert.equal(extension.home.variant, 'studio-board')
    assert.equal(builtin.mode, mode)
    assert.equal(extension.mode, mode)
  }
  assert.throws(() => snapshotFor('unregistered-case', 'light', 3), /Unknown appearance test case/)
})

test('PluginKit retains declared third-party layout markers and generic hooks without remounting', async () => {
  const context = fixture(snapshotFor('default', 'light', 1))
  await Promise.resolve(); await Promise.resolve()
  assert.equal(context.root.dataset.appearanceLayout, 'default')
  const extension = snapshotFor('contract', 'dark', 2)
  context.emit(extension)
  assert.equal(context.root.dataset.appearanceTheme, 'contract-theme')
  assert.equal(context.root.dataset.appearanceLayout, 'studio-board')
  assert.equal(context.root.dataset.theme, 'dark')
  assert.equal(context.properties.get('--appearance-gap'), `${extension.layout.gap}px`)
  assert.equal(context.properties.get('--appearance-columns'), String(extension.layout.columns))
  assert.equal(context.properties.get('--font-mono'), extension.fonts.mono)
  assert.equal(context.adapter.root, context.container)
  assert.equal(context.container.dataset.layoutFamily, 'editor')
  context.emit(snapshotFor('default', 'light', 1))
  assert.equal(context.root.dataset.appearanceLayout, 'studio-board', 'stale reads do not erase an extension snapshot')
  context.destroy()
  assert.equal(context.unsubscribed, 1)
})

test('PluginKit rejects malformed layout markers rather than maintaining a theme-name allowlist', async () => {
  const context = fixture(snapshotFor('default', 'light', 1))
  await Promise.resolve(); await Promise.resolve()
  const extension = snapshotFor('contract', 'light', 2)
  for (const [index, variant] of ['../private', 'studio board', 'a'.repeat(65), '<style>'].entries()) {
    context.emit({ ...extension, revision: index + 2, layout: { ...extension.layout, variant } })
    assert.equal(context.root.dataset.appearanceLayout, 'default')
  }
  context.emit({ ...extension, revision: 9, layout: { ...extension.layout, variant: 'custom-grid_2' } })
  assert.equal(context.root.dataset.appearanceLayout, 'custom-grid_2')
  context.destroy()
})

test('PluginKit CSS keeps generic regions and token geometry without retired built-in style branches', async () => {
  assert.deepEqual((await transform(css, { loader: 'css' })).warnings, [])
  assert.doesNotMatch(css, /data-appearance-layout=['"](?:ink|sketch|painted|tech)['"]|five-theme/)
  assert.match(css, /:root\[data-appearance-layout\] \.pk-appearance\[data-layout-family\]/)
  assert.match(css, /\.pk-appearance \[data-appearance-region\] \{ min-width: 0;/)
  assert.match(css, /--editor-gap: var\(--appearance-gap\)/)
  assert.match(css, /var\(--appearance-sidebar-width\)/)
  assert.match(css, /border-radius: var\(--appearance-control-radius\)/)
  assert.match(css, /data-mode="quick"/)
  assert.match(css, /prefers-reduced-motion: reduce/)
})
