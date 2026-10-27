import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const drain = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }
let source
async function fixture(options = {}) {
  if (!source) {
    const bundle = await build({
      absWorkingDir: root, bundle: true, write: false, format: 'cjs', platform: 'browser', logLevel: 'silent',
      stdin: { resolveDir: root, contents: `
        import PluginKit from './packages/plugin-kit/plugin-kit.js';
        export { PluginKit };
        export { createPersistence, DATA_KEY } from './plugins/drawboard/src/js/store.mjs';
      ` },
    })
    source = bundle.outputFiles[0].text
  }
  const callbacks = new Map(), timers = new Map(), pending = new Map(), durable = new Map(), calls = []
  let timerId = 0, setFailures = options.setFailures ?? 0, flushFailures = options.flushFailures ?? 0
  const on = name => callback => {
    const set = callbacks.get(name) ?? new Set()
    set.add(callback); callbacks.set(name, set)
    return () => set.delete(callback)
  }
  const host = {
    getLaunchMode: () => 'shell',
    onBeforeClose: on('beforeClose'), onBeforeSuspend: on('beforeSuspend'), onSaveRequested: on('saveRequested'),
    onDestroy: on('destroy'),
    storage: {
      get: async key => pending.get(key) ?? durable.get(key),
      set: async (key, value) => {
        calls.push({ type: 'set', key, value: plain(value) })
        if (options.setGate) await options.setGate.promise
        if (setFailures > 0) { setFailures--; throw new Error('Fixture set failure') }
        pending.set(key, plain(value))
        return true
      },
      ...(options.legacy ? {} : { flush: async () => {
        calls.push({ type: 'flush' })
        if (options.flushGate) await options.flushGate.promise
        if (flushFailures > 0) { flushFailures--; throw new Error('Fixture flush failure') }
        for (const [key, value] of pending) durable.set(key, value)
        pending.clear()
        return { commitId: 'fixture', committedAt: 1, committedKeys: durable.size }
      } }),
    },
  }
  const window = { [options.legacyAlias ? 'zapi' : 'enest']: host, addEventListener() {}, removeEventListener() {} }
  const notice = { dataset: {}, hidden: true }
  const document = {
    documentElement: { dataset: {} }, readyState: 'loading', addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [], querySelector: () => null, getElementById: () => notice,
  }
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, window, document, URLSearchParams, structuredClone,
    location: { search: '', pathname: '/fixture/index.html' },
    MutationObserver: class { observe() {} },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id),
  })
  const { PluginKit, createPersistence, DATA_KEY } = module.exports
  const kit = PluginKit.create(), persistence = createPersistence(kit)
  const disposers = ['onBeforeClose', 'onBeforeSuspend', 'onSaveRequested'].map(name => kit.api[name](() => persistence.flush()))
  return {
    host, kit, persistence, DATA_KEY, timers, calls, pending, durable,
    emit(name) {
      const results = [...(callbacks.get(name) ?? [])].map(callback => {
        try { return Promise.resolve(callback()) } catch (error) { return Promise.reject(error) }
      })
      return Promise.all(results)
    },
    dispose() { disposers.forEach(off => off()); kit.destroy(); timers.clear() },
  }
}

function draft(label) {
  return { version: 1, activeId: 'draft', drafts: [{ id: 'draft', name: label, objects: [], viewport: null }] }
}

test('PluginKit exposes the exact existing host through a readonly api property, including the legacy alias', async () => {
  for (const legacyAlias of [false, true]) {
    const f = await fixture({ legacyAlias })
    try {
      assert.equal(f.kit.api, f.host)
      const descriptor = Object.getOwnPropertyDescriptor(f.kit, 'api')
      assert.equal(descriptor.writable, false)
      assert.equal(descriptor.configurable, false)
      assert.throws(() => { f.kit.api = {} }, /read only|Cannot assign/)
    } finally { f.dispose() }
  }
})

for (const event of ['beforeClose', 'beforeSuspend', 'saveRequested']) {
  test(`drawboard ${event} queues the latest debounced snapshot and waits for durable flush`, async () => {
    const setGate = deferred(), flushGate = deferred(), f = await fixture({ setGate, flushGate })
    try {
      f.persistence.saveData(draft('older'))
      f.persistence.saveData(draft('latest'))
      assert.equal(f.calls.length, 0, 'the debounce has not fired')
      let settled = false
      const completion = f.emit(event).then(() => { settled = true })
      await drain()
      assert.equal(f.calls.filter(call => call.type === 'set').length, 1)
      assert.equal(f.calls[0].value.drafts[0].name, 'latest')
      assert.equal(settled, false)
      assert.equal(f.calls.some(call => call.type === 'flush'), false, 'flush must follow accepted writes')
      setGate.resolve()
      await drain()
      assert.equal(f.calls.some(call => call.type === 'flush'), true)
      assert.equal(settled, false)
      assert.equal(f.durable.size, 0)
      flushGate.resolve()
      await completion
      assert.equal(f.durable.get(f.DATA_KEY).drafts[0].name, 'latest')
      assert.equal([...f.timers.values()].some(timer => timer.delay === 800), false)
    } finally { setGate.resolve(); flushGate.resolve(); f.dispose() }
  })
}

test('failed queued writes propagate through lifecycle acknowledgement and the retained draft can retry', async () => {
  const f = await fixture({ setFailures: 1 })
  try {
    f.persistence.saveData(draft('keep after failure'))
    await assert.rejects(f.emit('beforeSuspend'), /Fixture set failure/)
    assert.equal(f.durable.size, 0)
    await f.emit('beforeSuspend')
    assert.equal(f.durable.get(f.DATA_KEY).drafts[0].name, 'keep after failure')
  } finally { f.dispose() }
})

test('a failed durability barrier is reported and a later flush can commit the accepted snapshot', async () => {
  const f = await fixture({ flushFailures: 1 })
  try {
    f.persistence.saveData(draft('retry durable barrier'))
    await assert.rejects(f.persistence.flush(), /Fixture flush failure/)
    assert.equal(f.durable.size, 0)
    assert.equal(f.pending.get(f.DATA_KEY).drafts[0].name, 'retry durable barrier')
    await f.persistence.flush()
    assert.equal(f.durable.get(f.DATA_KEY).drafts[0].name, 'retry durable barrier')
  } finally { f.dispose() }
})

test('legacy hosts retain best-effort lifecycle saves but never manufacture an explicit durable receipt', async () => {
  const f = await fixture({ legacy: true, legacyAlias: true })
  try {
    f.persistence.saveData(draft('legacy'))
    await f.emit('beforeClose')
    assert.equal(f.pending.get(f.DATA_KEY).drafts[0].name, 'legacy')
    assert.equal(f.calls.some(call => call.type === 'flush'), false)
    await assert.rejects(f.kit.flush(), /不支持持久化提交确认/)
  } finally { f.dispose() }
})

test('drawboard subscribes all three acknowledged save events through the host reference', () => {
  const app = readFileSync(resolve(root, 'plugins/drawboard/src/jsx/App.jsx'), 'utf8')
  for (const event of ['onBeforeClose', 'onBeforeSuspend', 'onSaveRequested']) {
    assert.ok(app.includes(`kit.api?.${event}?.(() => persist.flush())`), event)
  }
})
