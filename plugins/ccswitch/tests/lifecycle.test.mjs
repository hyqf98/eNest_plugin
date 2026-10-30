import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('lifecycle wrappers retain the host string mode and namespace-owned hotkey unsubscribe', async t => {
  const previousWindow = globalThis.window
  t.after(() => { globalThis.window = previousWindow })
  const handlers = new Map()
  const subscribe = name => callback => {
    handlers.set(name, callback)
    return () => handlers.delete(name)
  }
  globalThis.window = { enest: {
    onModeChange: subscribe('mode'),
    hotkey: { onHotkey: subscribe('hotkey') },
    onHotkey: () => { throw new Error('Not a host API') }
  } }
  const { onModeChange, onHotkey } = await import('../src/js/api.js')
  const modes = [], hotkeys = []
  const offMode = onModeChange(mode => modes.push(mode))
  const offHotkey = onHotkey(event => hotkeys.push(event))
  handlers.get('mode')('quick')
  handlers.get('mode')('shell')
  handlers.get('hotkey')({ accelerator: 'CommandOrControl+K' })
  assert.deepEqual(modes, ['quick', 'shell'])
  assert.equal(hotkeys.length, 1)
  offMode()
  offHotkey()
  assert.equal(handlers.size, 0)
})

test('the component owns cleanup for its lifecycle and late Quick subscriptions', async () => {
  const source = await readFile(new URL('../src/jsx/App.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /window\.enest\?\.onHotkey/)
  assert.match(source, /const offHotkey = onHotkey\(/)
  assert.match(source, /const offMode = onModeChange\(applyMode\)/)
  assert.match(source, /applyMode\(getLaunchMode\(\)\)/)
  for (const name of ['offEnter', 'offMode', 'offTheme', 'offHotkey', 'offQuickQuery']) assert.ok(source.includes(`${name}?.()`))
  assert.match(source, /if \(disposed\) off\?\.\(\)/)
})
