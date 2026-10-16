import { test, expect } from '@playwright/test'
async function setup(page, mode = 'shell', seed = {}) {
  await page.addInitScript(
    ({ mode, seed }) => {
      const listeners = {
          mode: [],
          enter: [],
          close: [],
          settings: [],
          focus: [],
          query: [],
          actions: [],
        },
        prefs = {}
      let currentMode = mode
      window.__store = structuredClone(seed)
      window.__requests = []
      window.__saved = []
      window.__copied = []
      let state = {
        state: {
          status: 'idle',
          phase: 'focus',
          remainingMs: 1500000,
          deadline: null,
          startedAt: null,
          cycle: 1,
          options: {
            focusMin: 25,
            breakMin: 5,
            longBreakMin: 15,
            longBreakEvery: 4,
            autoStart: false,
            notify: true,
            task: '',
          },
        },
        records: [],
      }
      const register = (key) => (fn) => {
        listeners[key].push(fn)
        return () => {
          listeners[key] = listeners[key].filter((f) => f !== fn)
        }
      }
      window.__host = {
        mode(value) {
          currentMode = value
          listeners.mode.forEach((fn) => fn(value))
        },
        enter(payload) {
          listeners.enter.forEach((fn) => fn({ payload, mode: currentMode }))
        },
        query(value) {
          listeners.query.forEach((fn) => fn(value))
        },
        action(value) {
          listeners.actions.forEach((fn) => fn(value))
        },
        close: () => Promise.all(listeners.close.map((fn) => fn())),
        state: () => state,
      }
      const changed = () => {
        listeners.focus.forEach((fn) => fn(structuredClone(state)))
        return Promise.resolve(structuredClone(state))
      }
      window.enest = {
        getLaunchMode: () => currentMode,
        onModeChange: register('mode'),
        onEnter: register('enter'),
        onBeforeClose: register('close'),
        onDestroy: () => () => {},
        ui: {
          setTitle: async () => {},
          setHeight: async () => {},
          setInputContext: async () => {},
          openSettings: async () => {},
          focusSearch: async () => {},
        },
        quickInput: {
          configure: async () => {},
          onChange: register('query'),
          onAction: register('actions'),
          escape: async () => {},
        },
        storage: {
          get: async (key) => {
            if (window.__store.__slowLoad)
              await new Promise((resolve) =>
                setTimeout(resolve, window.__store.__slowLoad),
              )
            return structuredClone(window.__store[key])
          },
          set: async (key, value) => {
            await new Promise((r) => setTimeout(r, 5))
            window.__store[key] = structuredClone(value)
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
          readText: async () => '粘贴的文本',
        },
        shell: {
          saveTextFile: async (value) => {
            window.__saved.push(value)
            return { ok: true }
          },
        },
        net: {
          fetch: (request) =>
            new Promise((resolve) =>
              window.__requests.push({ request, resolve }),
            ),
        },
        focusTimer: {
          get: async () => structuredClone(state),
          onChange: register('focus'),
          start: async (options) => {
            state.state = {
              ...state.state,
              status: 'running',
              options,
              remainingMs: options.focusMin * 60000,
              deadline: Date.now() + options.focusMin * 60000,
              startedAt: Date.now(),
            }
            return changed()
          },
          pause: async () => {
            state.state.status = 'paused'
            return changed()
          },
          resume: async () => {
            state.state.status = 'running'
            return changed()
          },
          stop: async () => {
            state.state.status = 'idle'
            return changed()
          },
          skip: async () => {
            state.state.phase =
              state.state.phase === 'focus' ? 'break' : 'focus'
            state.state.status = 'paused'
            return changed()
          },
          updateRecord: async (id, patch) => {
            state.records = state.records
              .filter((r) => r.id !== id || !patch.deleted)
              .map((r) => (r.id === id ? { ...r, ...patch } : r))
            return changed()
          },
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
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
}

test('待办迁移、详情编辑、撤销和入口切换保留数据', async ({ page }) => {
  await setup(page, 'quick', {
    todos_v1: [
      { id: 'old', text: '已有任务', done: false, pinned: true, createdAt: 1 },
    ],
  })
  await page.goto('/plugins/todos/index.html?mode=quick')
  await expect(page.locator('.task-title')).toHaveText('已有任务')
  expect(await page.evaluate(() => window.__store.todos_v1_backup[0].id)).toBe(
    'old',
  )
  await page.locator('#new-task').fill('准备发布清单')
  await page.locator('#new-task').press('Enter')
  await expect(page.locator('.task-title')).toHaveCount(2)
  await page.getByText('准备发布清单', { exact: true }).click()
  await page.locator('[data-field="due"]').fill('2026-12-01')
  await page.locator('[data-field="note"]').fill('保留草稿')
  await page.locator('#subinput').fill('检查安装包')
  await page.locator('#subinput').press('Enter')
  await page.evaluate(() => window.__host.mode('shell'))
  await page.setViewportSize({ width: 1200, height: 780 })
  await expect(page.locator('[data-field="note"]')).toHaveValue('保留草稿')
  await page.locator('#delete-task').click()
  await expect(page.locator('.task-title')).toHaveCount(1)
  await page.locator('#undo').click()
  await expect(page.locator('.task-title')).toHaveCount(2)
  await page.evaluate(() => window.__host.close())
  const saved = await page.evaluate(() =>
    window.__store.todos_v2.tasks.find((t) => t.text === '准备发布清单'),
  )
  expect(saved.note).toBe('保留草稿')
  expect(saved.subtasks[0].text).toBe('检查安装包')
  await noOverflow(page)
})

test('便签旧数据读取、切颜色及关闭保存不丢最后输入', async ({ page }) => {
  await setup(page, 'shell', {
    notes_v1: [
      {
        id: 'memo',
        text: '旧版本便签',
        color: '#f5a524',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })
  await page.goto('/plugins/sticky-notes/index.html')
  await expect(page.locator('.note-title')).toHaveText('旧版本便签')
  await page.locator('.note-row').click()
  await page.locator('#body').fill('# 项目记录\n\n**保存最后字符**')
  await page.locator('[data-color="#7fa894"]').click()
  await expect(page.locator('#body')).toHaveValue(
    '# 项目记录\n\n**保存最后字符**',
  )
  await page.locator('#preview-toggle').click()
  await expect(page.locator('#preview strong')).toHaveText('保存最后字符')
  await page.locator('#preview-toggle').click()
  await page.evaluate(() => window.__host.mode('quick'))
  await page.setViewportSize({ width: 706, height: 540 })
  await page.locator('#body').fill('刚刚输入的最后一个字')
  await page.evaluate(() => window.__host.close())
  expect(await page.evaluate(() => window.__store.notes_v2.notes[0].text)).toBe(
    '刚刚输入的最后一个字',
  )
  expect(
    await page.evaluate(() => window.__store.notes_v1_backup[0].text),
  ).toBe('旧版本便签')
  await noOverflow(page)
})

test('翻译丢弃过期请求，清空使在途请求失效，收藏保存本地', async ({ page }) => {
  await setup(page)
  await page.goto('/plugins/translate/index.html')
  await page.waitForFunction(() => window.__store.translate_prefs_v2_migrated)
  await page.locator('#input').fill('first')
  await page.locator('#run').click()
  await page.waitForFunction(() => window.__requests.length === 1)
  await page.locator('#input').fill('second')
  await page.locator('#run').click()
  await page.waitForFunction(() => window.__requests.length === 2)
  await page.evaluate(() =>
    window.__requests[1].resolve({
      status: 200,
      body: JSON.stringify([[['第二条', 'second']], null, 'en']),
    }),
  )
  await expect(page.locator('#output')).toHaveText('第二条')
  await page.evaluate(() =>
    window.__requests[0].resolve({
      status: 200,
      body: JSON.stringify([[['过期结果', 'first']], null, 'en']),
    }),
  )
  await expect(page.locator('#output')).toHaveText('第二条')
  await page.locator('#favorite').click()
  await page.evaluate(() => window.__host.close())
  expect(
    await page.evaluate(
      () => window.__store.translate_history_v2.history[0].starred,
    ),
  ).toBe(true)
  await page.locator('#input').fill('third')
  await page.locator('#run').click()
  await page.waitForFunction(() => window.__requests.length === 3)
  await page.locator('#clear').click()
  await page.evaluate(() =>
    window.__requests[2].resolve({
      status: 200,
      body: JSON.stringify([[['不应出现', 'third']], null, 'en']),
    }),
  )
  await expect(page.locator('#output')).toHaveText('译文会显示在这里')
  await noOverflow(page)
})

test('番茄钟使用宿主状态，切入口保留任务，暂停与跳过分离', async ({ page }) => {
  await setup(page, 'quick')
  await page.setViewportSize({ width: 706, height: 540 })
  await page.goto('/plugins/pomodoro/index.html?mode=quick')
  await expect(page.locator('#toggle')).toBeEnabled()
  await page.locator('#task').fill('审阅设计稿')
  await page.locator('#toggle').click()
  await expect(page.locator('#toggle')).toHaveText('暂停')
  await page.evaluate(() => window.__host.mode('shell'))
  await page.setViewportSize({ width: 1200, height: 780 })
  await expect(page.locator('#task')).toHaveValue('审阅设计稿')
  await page.locator('#toggle').click()
  await expect(page.locator('#toggle')).toHaveText('继续计时')
  await page.locator('#skip').click()
  await expect(page.locator('#status')).toHaveText('已暂停 · 短休息')
  expect(await page.evaluate(() => window.__host.state().records.length)).toBe(
    0,
  )
  await noOverflow(page)
})
for (const plugin of ['todos', 'sticky-notes', 'pomodoro', 'translate'])
  test(`${plugin} 入口与窗宽解耦`, async ({ page }) => {
    await setup(page, 'quick', {
      todos_v1: [
        {
          id: 'sample',
          text: '核对本周发布清单',
          done: false,
          pinned: true,
          createdAt: Date.now(),
        },
      ],
      notes_v1: [
        {
          id: 'sample',
          title: '今天的工作笔记',
          text: '## 下一步\n整理需求与验收细节。\n\n- [ ] 检查快捷窗口\n- [ ] 完成设计复核',
          pinned: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    })
    await page.setViewportSize({ width: 706, height: 540 })
    await page.goto(`/plugins/${plugin}/index.html?mode=quick`)
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'quick')
    await noOverflow(page)
    await page.screenshot({
      path: `/tmp/enest-productivity-visual/${plugin}-quick.png`,
    })
    await page.setViewportSize({ width: 1100, height: 600 })
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'quick')
    await page.evaluate(() => window.__host.mode('shell'))
    await page.setViewportSize({ width: 1200, height: 780 })
    await page.screenshot({
      path: `/tmp/enest-productivity-visual/${plugin}-shell.png`,
    })
    await page.setViewportSize({ width: 720, height: 650 })
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'shell')
    await noOverflow(page)
  })

test('初始化期间的入口载荷与紧接关闭等待迁移，不覆盖旧便签', async ({
  page,
}) => {
  await setup(page, 'quick', {
    __slowLoad: 150,
    notes_v1: [
      { id: 'keep', text: '必须保留的旧便签', createdAt: 1, updatedAt: 1 },
    ],
  })
  await page.goto('/plugins/sticky-notes/index.html?mode=quick')
  await page.evaluate(() =>
    window.__host.enter({ type: 'text', text: '入口传来的新笔记' }),
  )
  await page.evaluate(() => window.__host.close())
  expect(
    await page.evaluate(() => window.__store.notes_v2.notes.map((n) => n.text)),
  ).toEqual(expect.arrayContaining(['必须保留的旧便签', '入口传来的新笔记']))
  expect(
    await page.evaluate(() => window.__store.notes_v1_backup[0].text),
  ).toBe('必须保留的旧便签')
})
test('壳设置变更即时影响待办视图，false 默认不被当成缺失', async ({ page }) => {
  await setup(page, 'shell', {
    todos_v1: [
      { id: 'done', text: '已完成的旧任务', done: true, createdAt: 1 },
    ],
  })
  await page.goto('/plugins/todos/index.html')
  await page.waitForFunction(() => window.__store.todos_v2)
  await expect(page.locator('.task-title')).toHaveCount(0)
  await page.evaluate(() => window.enest.settings.set('showCompleted', true))
  await expect(page.locator('.task-title')).toHaveText('已完成的旧任务')
  await page.evaluate(() => window.enest.settings.set('showCompleted', false))
  await expect(page.locator('.task-title')).toHaveCount(0)
})
