import { test, expect } from '@playwright/test'

// 冒烟：markdown / unit-convert 两个插件的 Quick 与桌面形态。
// 宿主 API 全部 mock（同 productivity.ui.js 模式）；net.fetch 由测试用例手动 resolve。

async function setup(page, mode = 'shell', seed = {}) {
  await page.addInitScript(
    ({ mode, seed }) => {
      const listeners = { mode: [], enter: [], close: [], settings: [], query: [], actions: [], out: [] }
      const prefs = {}
      let currentMode = mode
      window.__store = structuredClone(seed)
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
          toast: async () => {},
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

async function noOverflow(page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true)
}

// ———— markdown ————
test('笔记：编辑自动保存、预览渲染、全文搜索与关闭 flush', async ({ page }) => {
  await setup(page, 'shell', {
    mdnotes_v1: {
      version: 1,
      groups: ['收件箱'],
      notes: [
        {
          id: 'n1',
          title: '会议记录',
          group: '收件箱',
          content: '# 标题\n\n**粗体** 与 `代码`\n\n- [ ] 任务',
          attachments: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
  })
  await page.goto('/plugins/markdown/index.html')
  await expect(page.locator('.note-title')).toHaveText('会议记录')
  // 预览（桌面默认开）
  await expect(page.locator('#preview strong')).toHaveText('粗体')
  // 编辑 → 防抖保存
  await page.locator('#editor').fill('# 新内容\n\n- [x] 完成')
  await expect(page.locator('#save-state')).toHaveText(/未保存|已保存/)
  await expect(page.locator('#preview h1')).toHaveText('新内容')
  await expect(page.locator('#preview li.done')).toHaveCount(1)
  await page.waitForFunction(() => window.__store.mdnotes_v1)
  await page.waitForTimeout(900)
  expect(
    await page.evaluate(() => window.__store.mdnotes_v1.notes[0].content),
  ).toContain('新内容')
  // 全文搜索高亮
  await page.locator('#search').fill('新内容')
  await expect(page.locator('.note-title mark')).toHaveText('新内容')
  await page.locator('#search').fill('')
  // 导出
  await page.locator('#export-md').click()
  expect(await page.evaluate(() => window.__saved.at(-1).defaultName)).toBe('会议记录.md')
  await noOverflow(page)
  // Quick 单栏
  await page.evaluate(() => window.__host.mode('quick'))
  await page.setViewportSize({ width: 706, height: 540 })
  await expect(page.locator('.tree-pane')).toBeHidden()
  await noOverflow(page)
  // 关闭 flush 不丢最后输入
  await page.locator('#editor').fill('关闭前的最后字符')
  await page.evaluate(() => window.__host.close())
  expect(
    await page.evaluate(() => window.__store.mdnotes_v1.notes[0].content),
  ).toBe('关闭前的最后字符')
})

// ———— unit-convert ————
test('单位换算：联动、进制互转、汇率缓存回退与大写', async ({ page }) => {
  await setup(page, 'shell')
  await page.goto('/plugins/unit-convert/index.html')
  // 长度联动：1 in = 2.54 cm
  await page.locator('[data-unit="in"]').fill('1')
  await expect(page.locator('[data-unit="cm"]')).toHaveValue(/^2\.54/)
  // 预设点击切换类目
  await page.locator('[data-preset="1 lb = 453.59 g"]').click()
  await expect(page.locator('[data-unit="g"]')).toHaveValue(/^453\.59/)
  // 进制
  await page.locator('[data-tab="radix"]').click()
  await page.locator('[data-radix="10"]').fill('255')
  await expect(page.locator('[data-radix="16"]')).toHaveValue('FF')
  await expect(page.locator('[data-radix="2"]')).toHaveValue('1111 1111')
  // 温度
  await page.locator('[data-tab="temp"]').click()
  await page.locator('[data-unit="C"]').fill('100')
  await expect(page.locator('[data-unit="F"]')).toHaveValue('212')
  // 汇率：先放缓存，断网路径走缓存
  await page.evaluate(() => {
    window.__store.fx_cache = { rates: { USD: 1, CNY: 7.1, EUR: 0.9, JPY: 150 }, fetchedAt: Date.now() - 3600_000 }
  })
  await page.locator('[data-tab="fx"]').click()
  // 网络失败 → 缓存
  await page.evaluate(() => window.__requests.shift().reject(new Error('net down')))
  await expect(page.locator('#fx-state')).toContainText('缓存')
  await expect(page.locator('.fx-row', { hasText: 'CNY' }).locator('.row-value')).toHaveText('7.1')
  // 人民币大写
  await page.locator('#rmb-input').fill('1024.5')
  await expect(page.locator('#rmb-upper')).toHaveText('壹仟零贰拾肆元伍角整')
  await noOverflow(page)
  // Quick 形态：桌面专属区隐藏，且换行值保留（切回温度仍在）
  await page.evaluate(() => window.__host.mode('quick'))
  await page.setViewportSize({ width: 706, height: 540 })
  await expect(page.locator('#rmb-section')).toBeHidden()
  await expect(page.locator('#presets')).toBeHidden()
  await page.locator('[data-tab="temp"]').click()
  await page.locator('[data-unit="C"]').fill('100')
  await expect(page.locator('[data-unit="F"]')).toHaveValue('212')
  await noOverflow(page)
})
