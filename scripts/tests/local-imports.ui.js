import { test, expect } from '@playwright/test'

// Text importers must request host file capabilities and leave data intact on cancel/denial.

async function setup(page, mode = 'shell', seed = {}) {
  await page.addInitScript(
    ({ mode, seed }) => {
      const listeners = { mode: [], enter: [], close: [], settings: [], query: [], actions: [], out: [] }
      const prefs = {}
      let currentMode = mode
      window.__store = structuredClone(seed)
      window.__fileCalls = []; window.__fileMode = 'cancel'; window.__filePayload = ''; window.__toasts = []
      window.__copied = []
      window.__saved = []
      window.__requests = []
      window.__heights = []
      const register = (key) => (fn) => {
        listeners[key].push(fn)
        return () => {
          listeners[key] = listeners[key].filter((f) => f !== fn)
        }
      }
      window.__host = {
        mode(value) {
          currentMode = value
          listeners.mode.forEach((fn) => fn({ mode: value }))
        },
        enter(event) {
          listeners.enter.forEach((fn) => fn({ payload: event, mode: currentMode }))
        },
        query(value) {
          listeners.query.forEach((fn) => fn(value))
        },
        action(value) {
          listeners.actions.forEach((fn) => fn(value))
        },
        close: () => Promise.all(listeners.close.map((fn) => fn({ reason: 'tab-close' }))),
      }
      window.enest = {
        localFiles: {
          pick: async options => { window.__fileCalls.push(['pick', options]); if (window.__fileMode === 'deny') throw new Error('permission denied'); return window.__fileMode === 'cancel' ? [] : [{ id: 'authorized-import', name: 'backup.json', kind: 'file', size: 100 }] },
          read: async input => { window.__fileCalls.push(['read', input]); if (input.handleId !== 'authorized-import') throw new Error('invalid capability'); return window.__filePayload }
        },
        getLaunchMode: () => currentMode,
        onModeChange: register('mode'),
        onEnter: register('enter'),
        onBeforeClose: register('close'),
        onOut: register('out'),
        onDestroy: () => () => {},
        ui: {
          setTitle: async () => {},
          setHeight: async (h) => window.__heights.push(h),
          setInputContext: async () => {},
          openSettings: async () => {},
          focusSearch: async () => {},
          toast: async input => window.__toasts.push(input),
        },
        quickInput: {
          configure: async () => {},
          onChange: register('query'),
          onAction: register('actions'),
          escape: async () => {},
        },
        storage: {
          get: async (key) => structuredClone(window.__store[key]),
          set: async (key, value) => {
            window.__store[key] = structuredClone(value)
          },
          remove: async (key) => delete window.__store[key],
          blobs: {
            put: async ({ dataUrl }) => ({ id: 'blob-' + Math.random().toString(36).slice(2, 8) }),
            get: async (id) => window.__store['blob:' + id] || null,
            remove: async (id) => delete window.__store['blob:' + id],
          },
        },
        settings: {
          get: async (key) => prefs[key],
          set: async (key, value) => {
            prefs[key] = value
            listeners.settings.forEach((fn) => fn({ key, value }))
          },
          onChange: register('settings'),
        },
        clipboard: {
          writeText: async (text) => window.__copied.push(text),
          readText: async () => window.__clipText || '',
        },
        shell: {
          saveTextFile: async (value) => {
            window.__saved.push(value)
            return { ok: true, path: '/tmp/' + value.defaultName }
          },
        },
        net: {
          fetch: (request) =>
            new Promise((resolve, reject) => window.__requests.push({ request, resolve, reject })),
        },
        hotkey: {
          register: async () => ({ ok: true }),
          unregister: async () => true,
          onHotkey: () => () => {},
        },
        contribute: {
          registerQuickProvider: async () => ({ ok: true }),
          unregisterQuickProvider: async () => true,
          onQuickQuery: () => () => {},
          respondQuickQuery: async () => true,
        },
      }
    },
    { mode, seed },
  )
  page.on('pageerror', (error) => {
    throw error
  })
}


const cases = [
  { id: 'com.github.eNest.todos', button: '#import', key: 'todos_v2', seed: { version: 2, tasks: [], lists: ['收件箱'] }, payload: { version: 2, tasks: [{ text: 'Authorized task' }] }, limit: 5000000 },
  { id: 'com.github.eNest.sticky-notes', button: '#import', key: 'notes_v2', seed: { version: 2, notes: [] }, payload: { version: 2, notes: [{ text: 'Authorized note', title: 'Imported' }] }, limit: 10000000 },
]
for (const item of cases) test(`${item.id} imports through host file capability and preserves data on cancel or deny`, async ({ page }) => {
  await setup(page, 'shell', { [item.key]: item.seed })
  await page.goto(`/plugins/${item.id}/index.html`)
  await expect(page.locator(item.button)).toBeVisible()
  await expect(page.locator('input[type=file]')).toHaveCount(0)
  const before = await page.evaluate(() => structuredClone(window.__store))
  await page.locator(item.button).click()
  expect(await page.evaluate(() => window.__store)).toEqual(before)
  expect(await page.evaluate(() => window.__fileCalls)).toEqual([['pick', { kind: 'file', access: 'read' }]])
  await page.evaluate(() => { window.__fileMode = 'deny' })
  await page.locator(item.button).click()
  await expect(page.getByRole('status')).toContainText('permission denied')
  expect(await page.evaluate(() => window.__store)).toEqual(before)
  await page.evaluate(payload => { window.__fileMode = 'allow'; window.__filePayload = JSON.stringify(payload) }, item.payload)
  await page.locator(item.button).click()
  await expect.poll(() => page.evaluate(() => window.__fileCalls.filter(call => call[0] === 'read').length)).toBe(1)
  expect(await page.evaluate(() => window.__fileCalls.at(-1))).toEqual(['read', { handleId: 'authorized-import', encoding: 'text', maxBytes: item.limit }])
  await expect.poll(() => page.evaluate(key => JSON.stringify(window.__store[key]), item.key)).toContain('Authorized')
})
