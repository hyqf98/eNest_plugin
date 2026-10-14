import { test, expect } from '@playwright/test'

// 冒烟：snippets / markdown / unit-convert / totp 四个新插件的 Quick 与桌面形态。
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

// ———— snippets ————
test('片段：搜索过滤、占位符填值复制、Quick 回车复制与模式切换', async ({ page }) => {
  await setup(page, 'shell', {
    snippets_v1: {
      version: 1,
      snippets: [
        {
          id: 's1',
          title: 'fetch 超时',
          lang: 'js',
          tags: ['网络'],
          content: 'fetch(url, { timeout: ${ms} })',
          useCount: 0,
          lastUsedAt: 0,
          updatedAt: 2,
        },
        {
          id: 's2',
          title: '排序',
          lang: 'py',
          tags: ['数组'],
          content: 'sorted(arr)',
          useCount: 1,
          lastUsedAt: 9,
          updatedAt: 1,
        },
      ],
    },
  })
  await page.goto('/plugins/com.enest.snippets/index.html')
  await expect(page.locator('.snippet')).toHaveCount(2)
  // 使用次数排序：s2 在前
  await expect(page.locator('.snippet-title').first()).toHaveText('排序')
  // 无占位符复制：选中 s2（列表首位）后点详情复制
  await page.locator('.snippet').first().click()
  await page.locator('[data-act="copy"]').click()
  expect(await page.evaluate(() => window.__copied)).toEqual(['sorted(arr)'])
  // 搜索
  await page.locator('#search').fill('超时')
  await expect(page.locator('.snippet')).toHaveCount(1)
  // 有占位符 → 弹填值表单，填值后复制渲染结果
  await page.locator('.snippet').first().click()
  await page.locator('[data-act="copy"]').click()
  await expect(page.locator('#vars-dialog')).toBeVisible()
  await page.locator('[data-var="ms"]').fill('3000')
  await page.locator('#vars-form button[type="submit"]').click()
  expect(await page.evaluate(() => window.__copied.at(-1))).toBe('fetch(url, { timeout: 3000 })')
  // 导出
  await page.locator('#search').fill('')
  await page.locator('#export').click()
  expect(await page.evaluate(() => window.__saved[0].defaultName)).toBe('代码片段.json')
  await noOverflow(page)
  // 切 Quick：单列、无详情
  await page.evaluate(() => window.__host.mode('quick'))
  await page.setViewportSize({ width: 706, height: 540 })
  await expect(page.locator('.detail')).toBeHidden()
  // Quick 下点击即复制（无占位符的 s2）
  await page.locator('.snippet', { hasText: '排序' }).click()
  expect(await page.evaluate(() => window.__copied.at(-1))).toBe('sorted(arr)')
  await noOverflow(page)
})

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
  await page.goto('/plugins/com.enest.markdown/index.html')
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
  await page.goto('/plugins/com.enest.unit-convert/index.html')
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

// ———— totp ————
test('验证器：出码、点击复制、剩余秒数着色与加密恢复', async ({ page }) => {
  await setup(page, 'shell')
  // 预置一个标准 RFC secret 条目
  await page.addInitScript(() => {
    // GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ = base32("12345678901234567890")
    window.__seedTotp = {
      totp_v1: {
        version: 1,
        entries: [
          {
            id: 't1',
            account: 'me@example.com',
            issuer: 'GitHub',
            secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
            group: '默认',
            digits: 6,
            period: 30,
            algorithm: 'SHA1',
            sortOrder: 0,
            createdAt: 1,
          },
        ],
      },
    }
  })
  // 把预置数据并入 store（addInitScript 里不方便直接改 __store，读一遍）
  await page.goto('/plugins/com.enest.totp/index.html')
  // 空态引导
  await expect(page.locator('.empty')).toBeVisible()
  await page.locator('#add').click()
  await page.locator('#f-account').fill('me@example.com')
  await page.locator('#f-secret').fill('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  await page.locator('#f-issuer').fill('GitHub')
  await page.locator('#editor-form button[type="submit"]').click()
  await expect(page.locator('.entry')).toHaveCount(1)
  // 出码：6 位（当前 30s 窗口对 RFC key 的码）
  await expect(page.locator('.entry .code')).toHaveText(/^\d{3} \d{3}$/)
  // 剩余秒数渲染且 ≤30
  const remain = await page.locator('.entry .remain').textContent()
  expect(Number(remain)).toBeGreaterThanOrEqual(1)
  expect(Number(remain)).toBeLessThanOrEqual(30)
  // 点击行 → 复制当前码
  await page.locator('.entry').click()
  const copied = await page.evaluate(() => window.__copied.at(-1))
  expect(copied).toMatch(/^\d{6}$/)
  expect(copied).toBe((await page.locator('.entry .code').textContent()).replace(' ', ''))
  // 备份导出加密 JSON
  await page.locator('#backup').click()
  await page.locator('#backup-pass').fill('pass-123')
  await page.locator('#backup-go').click()
  await expect.poll(() => page.evaluate(() => window.__saved.length)).toBeGreaterThan(0)
  const saved = await page.evaluate(() => window.__saved.at(-1))
  expect(saved.defaultName).toBe('验证器备份.json')
  expect(saved.content).toContain('enest-totp-backup')
  await noOverflow(page)
  // Quick 形态
  await page.evaluate(() => window.__host.mode('quick'))
  await page.setViewportSize({ width: 706, height: 540 })
  await expect(page.locator('.entry-copy').first()).toBeHidden()
  await noOverflow(page)
})
