import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

function fixture(storage = {}) {
  const window = { SshApi: { storageGet: async (key, fallback) => storage[key] ?? fallback, storageSet: async (key, value) => { storage[key] = value }, toast() {} } }
  new Function('window', readFileSync(new URL('../src/js/store.js', import.meta.url), 'utf8'))(window)
  return { store: window.SshStore, storage }
}

test('workspace restoration filters deleted profiles and duplicate tabs without retaining live sessions or secrets', async () => {
  const { store } = fixture({
    'ssh.profiles': [{ id: 'a' }, { id: 'b' }],
    'ssh.ui': { workspace: { activeTabId: 'two', layout: 'vertical', splitTabs: ['one', 'two', 'gone', 'one'], tabs: [
      { tabId: 'one', profileId: 'a', sessionId: 'live-id', password: 'not-metadata', buffer: 'private output' },
      { tabId: 'two', profileId: 'a', title: 'Pinned', pinned: true },
      { tabId: 'two', profileId: 'b' }, { tabId: 'gone', profileId: 'deleted' }
    ] } }
  })
  await store.loadAll()
  assert.deepEqual(store.state.ui.workspace, { version: 1, tabs: [{ tabId: 'two', profileId: 'a', title: 'Pinned', pinned: true }, { tabId: 'one', profileId: 'a', title: '', pinned: false }], activeTabId: 'two', layout: 'vertical', splitTabs: ['one', 'two'] })
})

test('legacy open profiles migrate to disconnected-tab metadata and proxy credentials remain vault references', async () => {
  const { store, storage } = fixture({ 'ssh.profiles': [{ id: 'a', password: 'never-save', proxy: { type: 'socks5', host: 'localhost', port: 1080, username: 'alice', secretRef: 'vault-ref', ephemeralSecret: 'one-off', password: 'legacy' }, jumps: [{ host: 'jump', ephemeralSecret: 'jump-secret' }] }], 'ssh.ui': { openProfileIds: ['a', 'missing'] } })
  await store.loadAll()
  assert.equal(store.state.ui.workspace.tabs.length, 1)
  assert.equal(store.state.ui.workspace.tabs[0].profileId, 'a')
  store.upsertProfile(store.state.profiles[0]); await store.flushAll()
  assert.equal(storage['ssh.profiles'][0].proxy.secretRef, 'vault-ref')
  assert.doesNotMatch(JSON.stringify(storage['ssh.profiles']), /never-save|one-off|legacy|jump-secret/)
})
