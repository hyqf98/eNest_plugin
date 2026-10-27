import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { createController } from '../src/market/controller.js'
import { normalizeWorkspaceRoute, WORKSPACE_ROUTES } from '../src/market/workspaceRoute.js'

const ID = 'com.github.eNest.fixture'
const snapshot = (generation = 7, revision = 11) => ({
  generation,
  appearance: { revision, theme: { source: 'com.github.eNest.sketchbook', id: 'sketchbook' } },
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture(t, options = {}) {
  let appearance = snapshot()
  let onCommand
  let onAppearance
  let sequence = 0
  const pending = new Map()
  const actions = []
  const acknowledgements = []
  const ready = []
  const detail = { pluginId: ID, name: 'Fixture', installed: true, category: 'Development' }
  const emit = command => onCommand?.(command)
  const hostNavigate = (route, requestId = `navigation-${++sequence}`) => {
    // Model the native host boundary independently of the plugin's normalizer.
    assert.ok(route.page === 'catalog' || route.page === 'detail', 'host never accepts installed as a route')
    const result = deferred()
    pending.set(requestId, result)
    emit({ type: 'navigate', route, requestId, generation: appearance.generation, revision: appearance.appearance.revision })
    return result.promise
  }
  const bridge = {
    onCommand(listener) { onCommand = listener; return () => { onCommand = undefined } },
    onAppearance(listener) { onAppearance = listener; return () => { onAppearance = undefined } },
    getAppearance: options.getAppearance ?? (async () => appearance),
    async getConfig() { return { locale: 'en-US' } },
    async getCatalog() { return { revision: 1, items: [detail] } },
    getDetail: options.getDetail ?? (async id => id === ID ? detail : null),
    async search() { return { revision: 1, items: [] } },
    async ready(payload) {
      assert.equal(payload.workspaceVersion, 1)
      assert.deepEqual(payload.routes, ['catalog', 'detail'])
      assert.equal(payload.revision, appearance.appearance.revision)
      ready.push(payload)
    },
    async ackNavigation(ack) {
      acknowledgements.push(ack)
      pending.get(ack.requestId)?.resolve(ack)
      pending.delete(ack.requestId)
    },
    async action(request) {
      actions.push(request)
      assert.equal(request.type, 'navigate')
      const ack = await hostNavigate(request.route)
      return ack.ok ? { ok: true } : { ok: false, error: 'Fixture navigation rejected' }
    },
  }
  const controller = createController(bridge, { afterPaint: async () => undefined })
  t.after(() => controller.dispose())
  return {
    controller, actions, acknowledgements, ready, emit, hostNavigate,
    updateAppearance(value) { appearance = value; onAppearance?.(value) },
    listeners: () => ({ command: Boolean(onCommand), appearance: Boolean(onAppearance) }),
  }
}

test('cold native-style startup advertises only catalog/detail and binds its initial generation', { timeout: 2000 }, async t => {
  const f = fixture(t)
  assert.deepEqual(f.controller.getState().route, { page: 'catalog' })
  await f.controller.start()
  assert.equal(f.ready.length, 1)
  assert.equal(f.controller.getState().generation, 7)
  assert.equal(f.controller.getState().loading, false)
  assert.deepEqual(f.actions, [])
  assert.deepEqual(f.acknowledgements, [])
})

test('installed/all change only local catalog state without host navigation or ACK', { timeout: 2000 }, async t => {
  const f = fixture(t)
  await f.controller.start()
  f.controller.setCategory('Development')
  f.controller.setQuery('fixture')
  f.controller.setBasePage('installed')
  assert.equal(f.controller.getState().basePage, 'installed')
  assert.deepEqual(f.controller.getState().route, { page: 'catalog' })
  assert.equal(f.controller.getState().category, 'Development')
  assert.equal(f.controller.getState().query, 'fixture')
  f.controller.setBasePage('invalid')
  assert.equal(f.controller.getState().basePage, 'installed')
  f.controller.setBasePage('catalog')
  assert.equal(f.controller.getState().basePage, 'catalog')
  assert.deepEqual(f.actions, [])
  assert.deepEqual(f.acknowledgements, [])
})

test('detail open and back ACK real host routes while preserving installed filter, category and query', { timeout: 2000 }, async t => {
  const f = fixture(t)
  await f.controller.start()
  f.controller.setBasePage('installed')
  f.controller.setCategory('Development')
  f.controller.setQuery('fixture')
  await f.controller.navigate({ page: 'detail', pluginId: ID })
  assert.equal(f.controller.getState().detailStatus, 'ready')
  assert.equal(f.controller.getState().detail.pluginId, ID)
  assert.equal(f.controller.getState().basePage, 'installed')
  await f.controller.navigate({ page: 'catalog' })
  assert.deepEqual(f.actions.map(action => action.route), [{ page: 'detail', pluginId: ID }, { page: 'catalog' }])
  assert.deepEqual(f.acknowledgements, [
    { requestId: 'navigation-1', generation: 7, ok: true },
    { requestId: 'navigation-2', generation: 7, ok: true },
  ])
  const state = f.controller.getState()
  assert.deepEqual(state.route, { page: 'catalog' })
  assert.equal(state.basePage, 'installed')
  assert.equal(state.category, 'Development')
  assert.equal(state.query, 'fixture')
  assert.equal(state.detail, null)
  assert.equal(state.detailStatus, 'idle')
})

test('initial detail replay queued before bootstrap uses the first appearance generation', { timeout: 2000 }, async t => {
  const appearance = deferred()
  const f = fixture(t, { getAppearance: () => appearance.promise })
  const boot = f.controller.start()
  f.emit({ type: 'navigate', route: { page: 'detail', pluginId: ID }, requestId: 'stale', generation: 6, revision: 11 })
  const accepted = f.hostNavigate({ page: 'detail', pluginId: ID }, 'initial-detail')
  appearance.resolve(snapshot())
  await boot
  assert.deepEqual(await accepted, { requestId: 'initial-detail', generation: 7, ok: true })
  assert.equal(f.ready.length, 1)
  assert.equal(f.controller.getState().basePage, 'catalog')
  assert.deepEqual(f.acknowledgements.map(ack => ack.requestId), ['initial-detail'])
  await f.hostNavigate({ page: 'catalog' }, 'back')
  assert.deepEqual(f.controller.getState().route, { page: 'catalog' })
})

test('missing detail sends a negative ACK instead of claiming successful navigation', { timeout: 2000 }, async t => {
  const f = fixture(t, { getDetail: async () => null })
  await f.controller.start()
  f.controller.setBasePage('installed')
  await f.controller.navigate({ page: 'detail', pluginId: ID })
  assert.deepEqual(f.acknowledgements, [{ requestId: 'navigation-1', generation: 7, ok: false }])
  assert.equal(f.controller.getState().detailStatus, 'error')
  assert.equal(f.controller.getState().basePage, 'installed')
  await f.controller.navigate({ page: 'catalog' })
  assert.equal(f.controller.getState().basePage, 'installed')
})

test('back navigation supersedes an unfinished detail without a late success ACK or filter reset', { timeout: 2000 }, async t => {
  const detail = deferred()
  const f = fixture(t, { getDetail: () => detail.promise })
  await f.controller.start()
  f.controller.setBasePage('installed')
  void f.hostNavigate({ page: 'detail', pluginId: ID }, 'slow-detail')
  await f.hostNavigate({ page: 'catalog' }, 'back')
  detail.resolve({ pluginId: ID })
  await nextTurn()
  assert.deepEqual(f.acknowledgements, [{ requestId: 'back', generation: 7, ok: true }])
  assert.deepEqual(f.controller.getState().route, { page: 'catalog' })
  assert.equal(f.controller.getState().basePage, 'installed')
  assert.equal(f.controller.getState().detail, null)
})

test('appearance replacement, host catalog replay and openMarket never turn a local filter into a route', { timeout: 2000 }, async t => {
  const f = fixture(t)
  await f.controller.start()
  f.controller.setBasePage('installed')
  f.updateAppearance(snapshot(8, 12))
  assert.deepEqual(f.controller.getState().route, { page: 'catalog' })
  assert.equal(f.controller.getState().basePage, 'installed')
  f.emit({ type: 'navigate', route: { page: 'detail', pluginId: ID }, requestId: 'old-generation', generation: 7, revision: 12 })
  f.emit({ type: 'navigate', route: { page: 'detail', pluginId: ID }, requestId: 'old-revision', generation: 8, revision: 11 })
  await f.hostNavigate({ page: 'catalog' }, 'replay')
  f.emit({ type: 'openMarket', generation: 8, revision: 12 })
  assert.deepEqual(f.acknowledgements, [{ requestId: 'replay', generation: 8, ok: true }])
  assert.deepEqual(f.controller.getState().route, { page: 'catalog' })
  assert.equal(f.controller.getState().basePage, 'installed')
})

test('retired controller detaches both bridges and cannot ACK a late detail result', { timeout: 2000 }, async t => {
  const detail = deferred()
  const f = fixture(t, { getDetail: () => detail.promise })
  await f.controller.start()
  void f.hostNavigate({ page: 'detail', pluginId: ID }, 'retired')
  f.controller.dispose()
  detail.resolve({ pluginId: ID })
  await nextTurn()
  assert.deepEqual(f.listeners(), { command: false, appearance: false })
  assert.deepEqual(f.acknowledgements, [])
})

test('obsolete installed routes are rejected locally and never forwarded to the native host', { timeout: 2000 }, async t => {
  assert.deepEqual(WORKSPACE_ROUTES, ['catalog', 'detail'])
  assert.throws(() => normalizeWorkspaceRoute({ page: 'installed' }), /Invalid workspace route/)
  assert.throws(() => normalizeWorkspaceRoute({ page: 'catalog', filter: 'installed' }), /Invalid workspace route/)
  const f = fixture(t)
  await f.controller.start()
  await f.controller.navigate({ page: 'installed' })
  assert.deepEqual(f.actions, [])
  f.emit({ type: 'navigate', route: { page: 'installed' }, requestId: 'invalid', generation: 7, revision: 11 })
  await nextTurn()
  assert.deepEqual(f.acknowledgements, [{ requestId: 'invalid', generation: 7, ok: false }])
  assert.deepEqual(f.controller.getState().route, { page: 'catalog' })
})

test('UI filter/reset and every detail dismissal use the corrected controller paths', async () => {
  const ui = await readFile(new URL('../src/market/SketchMarket.js', import.meta.url), 'utf8')
  assert.match(ui, /tab\.addEventListener\('click', \(\) => controller\.setBasePage\(value\)\)/)
  assert.match(ui, /reset\.addEventListener\('click',[\s\S]*?controller\.setBasePage\('catalog'\)/)
  assert.match(ui, /async function requestClose\(\)[\s\S]*?await controller\.navigate\(\{ page: 'catalog' \}\)/)
  assert.doesNotMatch(ui, /navigate\(\{ page: (?:value|controller\.getState\(\)\.basePage)/)
  assert.match(ui, /close\.addEventListener\('click', requestClose/)
  assert.match(ui, /dialog\.addEventListener\('cancel',[\s\S]*?requestClose\(\)/)
  assert.match(ui, /event\.target === dialog && backdropDown\) void requestClose\(\)/)
  assert.match(ui, /event\.key === 'Escape'[\s\S]*?requestClose\(\)/)
  const preview = await readFile(new URL('../src/market/mockBridge.js', import.meta.url), 'utf8')
  assert.match(preview, /normalizeWorkspaceRoute\(request\.route\)/)
  assert.match(preview, /payload\.routes\.length !== WORKSPACE_ROUTES\.length/)
})

test('plugin, package and workspace lock all identify the 1.0.3 route fix', async () => {
  const root = new URL('../', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('plugin.json', root), 'utf8'))
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', root), 'utf8'))
  assert.equal(manifest.version, '1.0.3')
  assert.equal(pkg.version, manifest.version)
  assert.equal(lock.packages['plugins/sketchbook'].version, manifest.version)
  assert.equal(manifest.contributes.homePages[0].entry, 'homes/sketchbook.html')
})
