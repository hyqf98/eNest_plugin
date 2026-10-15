import { test, expect } from '@playwright/test'
import { fixture, connect, setQuery, navigate } from './database-fixture.js'

async function editorAction(page, action, offset) {
  return page.evaluate(async ({ action, offset }) => {
    const entry = performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name))
    const { monaco } = await import(entry.name), editor = monaco.editor.getEditors()[0]
    if (offset !== undefined) editor.setPosition(editor.getModel().getPositionAt(offset))
    editor.focus()
    if (action === 'suggest') editor.trigger('test', 'editor.action.triggerSuggest', {})
    if (action === 'undo') await editor.getModel().undo()
    return editor.getValue()
  }, { action, offset })
}
const labels = page => page.locator('.suggest-widget.visible .monaco-list-row .label-name')

test('Monaco completes a column before FROM on isolated lazy metadata and accepts in one undo', async ({ page }) => {
  await fixture(page); await connect(page)
  const sql = 'SELECT c.na FROM customers c;'
  await setQuery(page, sql)
  await editorAction(page, 'suggest', sql.indexOf('na') + 2)
  await expect(labels(page).filter({ hasText: /^name$/ })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect.poll(() => editorAction(page)).toBe('SELECT c.name FROM customers c;')
  expect(await editorAction(page, 'undo')).toBe(sql)
  const reads = await page.evaluate(() => window.__calls.filter(call => call[0] === 'schema.describe').map(call => call[1]))
  expect(reads.some(read => read.table === 'customers')).toBe(true)
  expect(reads.every(read => read.sessionKey.startsWith('db-nav:'))).toBe(true)
  const opens = await page.evaluate(() => window.__calls.filter(call => call[0] === 'open' && call[1].sessionKey.startsWith('db-nav:catalog:')).map(call => call[1].config))
  expect(opens.every(config => config.readOnly === true)).toBe(true)
})

test('star expansion uses the caret list, accepts directly in one undo, excludes COUNT star and never executes', async ({ page }) => {
  await fixture(page); await connect(page)
  const sql = 'SELECT * FROM customers c;'
  await setQuery(page, sql); await editorAction(page, '', 8)
  await page.locator('[data-action=expandColumns]').first().click()
  await expect(labels(page).filter({ hasText: '展开全部可见字段' })).toBeVisible()
  await expect(page.locator('.suggest-widget.visible')).toContainText('c.id, c.name')
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  expect(await editorAction(page)).toBe(sql)
  await page.screenshot({ path: 'test-results-db/database-sql-field-expansion-list.png' })
  await page.keyboard.press('Tab')
  await expect.poll(() => editorAction(page)).toBe('SELECT c.id, c.name FROM customers c;')
  expect(await editorAction(page, 'undo')).toBe(sql)
  await setQuery(page, 'SELECT COUNT(*) FROM customers;'); await editorAction(page, 'suggest', 14)
  await expect(labels(page).filter({ hasText: '展开全部可见字段' })).toHaveCount(0)
  expect(await page.evaluate(() => window.__calls.filter(call => call[0] === 'execute').length)).toBe(0)
})

test('settings field group appears in the real editor and native snippet placeholders navigate', async ({ page }) => {
  await fixture(page); await connect(page); await navigate(page, 'settings')
  await page.locator('[data-new-set]').click()
  await page.locator('[data-set-field=label]').fill('仅名称')
  await page.locator('[data-set-scope=table]').fill('customers')
  await page.locator('[data-manual-columns]').fill('name'); await page.locator('[data-manual-columns]').press('Tab')
  await page.locator('[data-copy-template]').click()
  await page.locator('[data-template-field=label]').fill('参数查询')
  await page.locator('[data-template-field=trigger]').fill('qqq')
  await page.locator('[data-template-field=generator]').selectOption('snippet')
  await page.locator('[data-template-body]').fill('SELECT ${1:id} FROM ${2:customers};$0')
  await page.locator('[data-save-completion]').click()
  await expect(page.locator('[data-save-state]')).toContainText('已保存')
  await page.locator('[data-back]').click()
  await setQuery(page, 'SELECT * FROM customers c;'); await editorAction(page, 'suggest', 8)
  await expect(labels(page).filter({ hasText: '常用字段：仅名称' })).toBeVisible()
  await page.keyboard.press('Escape')
  await setQuery(page, 'qqq'); await editorAction(page, 'suggest', 3)
  await expect(labels(page).filter({ hasText: /^qqq$/ })).toBeVisible()
  await page.keyboard.press('Tab'); await page.keyboard.type('name'); await page.keyboard.press('Tab'); await page.keyboard.type('customers_v2')
  await expect.poll(() => editorAction(page)).toBe('SELECT name FROM customers_v2;')
})

test('Escape prevents late metadata from reopening suggestions and switching documents rejects stale items', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { window.__strictSessionTasks = true; window.__deferCatalog = true })
  await connect(page); await setQuery(page, 'SELECT c. FROM customers c;')
  await editorAction(page, 'suggest', 9)
  await page.keyboard.press('Escape')
  await page.evaluate(() => { window.__deferCatalog = false; window.__pendingCatalog.splice(0).forEach(item => item.finish()) })
  await expect.poll(() => page.evaluate(() => window.__pendingCatalog.length)).toBe(0)
  await expect(page.locator('.suggest-widget.visible')).toHaveCount(0)
  await page.locator('[data-wb=newQuery]').first().click()
  await expect.poll(() => editorAction(page)).not.toBe('SELECT c. FROM customers c;')
  await expect(page.locator('.suggest-widget.visible')).toHaveCount(0)
})

test('typing a table after SELECT lazily generates all fields without opening the tree', async ({ page }) => {
  await fixture(page); await connect(page)
  const sql = 'SELECT customers'
  await setQuery(page, sql); await editorAction(page, 'suggest', sql.length)
  await expect(labels(page).filter({ hasText: /^sel · customers$/ })).toBeVisible()
  await labels(page).filter({ hasText: /^sel · customers$/ }).click()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await expect.poll(() => editorAction(page)).toMatch(/SELECT id, name\s+FROM customers\s+LIMIT 200;/)
  expect(await editorAction(page, 'undo')).toBe(sql)
})

test('editing the document while a projection list is open invalidates its old candidates', async ({ page }) => {
  await fixture(page); await connect(page)
  await setQuery(page, 'SELECT * FROM customers;'); await editorAction(page, '', 8)
  await page.locator('[data-action=expandColumns]').first().click()
  await expect(labels(page).filter({ hasText: '展开全部可见字段' })).toBeVisible()
  await setQuery(page, 'SELECT id FROM customers WHERE id = 2;')
  await page.keyboard.press('Escape')
  expect(await editorAction(page)).toBe('SELECT id FROM customers WHERE id = 2;')
  await expect(page.locator('.suggest-widget.visible')).toHaveCount(0)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
})

for (const scenario of [
  { mode: 'shell', width: 1024, height: 720, theme: 'light', font: 13 },
  { mode: 'shell', width: 1440, height: 900, theme: 'dark', font: 18 },
  { mode: 'quick', width: 480, height: 240, theme: 'light', font: 12 },
  { mode: 'quick', width: 720, height: 420, theme: 'dark', font: 12 }
]) test(`caret list stays bounded with inline types and comments at ${scenario.mode} ${scenario.width} ${scenario.theme}`, async ({ page }) => {
  await page.setViewportSize({ width: scenario.width, height: scenario.height })
  await fixture(page, scenario.mode)
  await page.evaluate(() => {
    const describe = enest.db.schema.describe
    enest.db.schema.describe = async request => {
      const detail = await describe(request)
      detail.columns[1].comment = '客户姓名 · 用于订单联系人显示的完整名称，备注很长时在当前行截断，悬停查看全部说明'
      return detail
    }
  })
  await connect(page)
  const sql = 'SELECT c. FROM customers c;'
  await setQuery(page, sql)
  await page.evaluate(async ({ theme, font }) => {
    document.documentElement.dataset.theme = theme
    const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name)
    monaco.editor.getEditors()[0].updateOptions({ fontSize: font })
  }, scenario)
  await editorAction(page, 'suggest', 9)
  const name = labels(page).filter({ hasText: /^name$/ })
  await expect(name).toBeVisible()
  const row = page.locator('.suggest-widget.visible .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: /^name$/ }) })
  await expect(row.locator('.signature-label')).toContainText('VARCHAR')
  await expect(row.locator('.details-label')).toContainText('客户姓名')
  await row.hover()
  await expect(row).toHaveAttribute('title', /客户姓名.*悬停查看全部说明/)
  const layout = await page.evaluate(async () => {
    const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name)
    const editor = monaco.editor.getEditors()[0], caret = editor.getScrolledVisiblePosition(editor.getPosition()), root = editor.getDomNode().getBoundingClientRect()
    const list = document.querySelector('.suggest-widget.visible'), r = list.getBoundingClientRect()
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, caretBottom: root.top + caret.top + caret.height, radius: getComputedStyle(list).borderRadius, width: innerWidth, height: innerHeight }
  })
  expect(layout.x).toBeGreaterThanOrEqual(0); expect(layout.right).toBeLessThanOrEqual(layout.width)
  expect(layout.y).toBeGreaterThanOrEqual(0); expect(layout.bottom).toBeLessThanOrEqual(layout.height)
  expect(layout.y).toBeGreaterThanOrEqual(layout.caretBottom - 2)
  expect(layout.radius).toBe('7px')
  await expect(page.locator('dialog[open], .suggest-details-container:visible, .completion-doc:visible')).toHaveCount(0)
  expect(await page.locator('.enest-float-tip').evaluateAll(nodes => nodes.some(node => getComputedStyle(node).opacity === '1' && /SQL 查询编辑器/.test(node.textContent)))).toBe(false)
  await page.screenshot({ path: `test-results-db/database-sql-list-${scenario.mode}-${scenario.width}-${scenario.theme}.png` })
  await page.keyboard.press('Escape')
  await expect(page.locator('.suggest-widget.visible')).toHaveCount(0)
})

test('lightweight fallback uses the same inline list and directly expands fields', async ({ page }) => {
  await page.route('**/monaco-*.js', route => route.abort())
  await fixture(page); await connect(page)
  const editor = page.locator('textarea[aria-label="查询编辑器"]')
  await expect(editor).toBeVisible()
  await editor.fill('SELECT * FROM customers c;')
  await editor.evaluate(element => { element.focus(); element.setSelectionRange(8, 8) })
  await page.locator('[data-action=expandColumns]').first().click()
  await expect(page.locator('.completion-popup:not([hidden])')).toContainText('c.id, c.name')
  await expect(page.locator('dialog[open], .completion-doc')).toHaveCount(0)
  await editor.press('Tab')
  await expect(editor).toHaveValue('SELECT c.id, c.name FROM customers c;')
})

test('cold sel offers table queries without prefetching every table and accepts one target directly', async ({ page }) => {
  await fixture(page); await connect(page)
  const sql = 'sel'
  await setQuery(page, sql); await editorAction(page, 'suggest', sql.length)
  const candidate = labels(page).filter({ hasText: /^sel · customers$/ })
  await expect(candidate).toBeVisible()
  expect(await page.evaluate(() => window.__calls.filter(call => call[0] === 'schema.describe').length)).toBe(0)
  await candidate.click()
  await expect.poll(() => editorAction(page)).toMatch(/SELECT id, name\s+FROM customers\s+LIMIT 200;/)
  const reads = await page.evaluate(() => window.__calls.filter(call => call[0] === 'schema.describe').map(call => call[1]))
  expect(reads).toHaveLength(1); expect(reads[0].table).toBe('customers'); expect(reads[0].sessionKey).toMatch(/^db-nav:/)
  expect(await editorAction(page, 'undo')).toBe(sql)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
})

test('Escape cancels an accepted deferred template while its isolated field read is pending', async ({ page }) => {
  await fixture(page)
  await page.evaluate(() => {
    const describe = enest.db.schema.describe
    enest.db.schema.describe = async request => { await new Promise(resolve => { window.__releaseColumns = resolve }); return describe(request) }
  })
  await connect(page); await setQuery(page, 'sel'); await editorAction(page, 'suggest', 3)
  await labels(page).filter({ hasText: /^sel · customers$/ }).click()
  await expect(labels(page).filter({ hasText: /正在读取 customers/ })).toBeVisible()
  await expect.poll(() => page.evaluate(() => typeof window.__releaseColumns)).toBe('function')
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__releaseColumns())
  await expect.poll(() => page.evaluate(() => window.__calls.some(call => call[0] === 'schema.describe'))).toBe(true)
  expect(await editorAction(page)).toBe('sel')
  await expect(page.locator('.suggest-widget.visible')).toHaveCount(0)
})

test('function parameter information stays inside the caret list and never inserts its label', async ({ page }) => {
  await fixture(page); await connect(page)
  await setQuery(page, 'SELECT COUNT'); await editorAction(page, '', 12)
  await page.keyboard.type('(')
  const signature = labels(page).filter({ hasText: /^COUNT\(expression\)$/ })
  await expect(signature).toBeVisible()
  await expect(page.locator('.suggest-widget.visible')).toContainText('当前参数 1')
  await signature.click()
  expect(await editorAction(page)).toMatch(/^SELECT COUNT\(/)
  expect(await editorAction(page)).not.toContain('expression')
  await expect(page.locator('.parameter-hints-widget:visible, .suggest-details-container:visible, dialog[open]')).toHaveCount(0)
})

test('SQL toolbar templates open the caret list and FROM space prioritizes object names', async ({ page }) => {
  await fixture(page); await connect(page); await setQuery(page, '')
  await page.locator('[data-action=templates]').first().click()
  await expect(labels(page).filter({ hasText: /^sel · customers$/ })).toBeVisible()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await setQuery(page, 'SELECT * FROM'); await editorAction(page, '', 13); await page.keyboard.type(' ')
  await expect(labels(page).filter({ hasText: /^customers$/ })).toBeVisible()
  await expect(labels(page).filter({ hasText: /^(WHERE|AS)$/ })).toHaveCount(0)
})

test('saved editor font size expands candidate rows and keeps the type readable', async ({ page }) => {
  await fixture(page); await connect(page); await navigate(page, 'settings')
  await page.locator('[data-pref=editorFontSize]').fill('24'); await page.locator('[data-pref=editorFontSize]').press('Tab')
  await page.locator('[data-back]').click()
  await setQuery(page, 'SELECT c. FROM customers c'); await editorAction(page, 'suggest', 9)
  const row = page.locator('.suggest-widget.visible .monaco-list-row').first()
  await expect(row).toBeVisible()
  expect((await row.boundingBox()).height).toBeGreaterThanOrEqual(40)
})

test('saved scoped functions, typed enums and behavior overrides take effect in the query editor', async ({ page }) => {
  await fixture(page); await connect(page); await navigate(page, 'settings')
  await page.getByText('自定义函数、枚举和高级配置', { exact: true }).click()
  await page.locator('[data-completion-json]').fill(JSON.stringify({
    functions: [{ id: 'masked', name: 'MASK_NAME', signature: 'MASK_NAME(name, keep)', scope: { connectionId: 'dev', table: 'customers' }, dialects: ['mysql'] }],
    enums: [{ id: 'names', column: 'name', scope: { connectionId: 'dev', table: 'customers' }, values: ['001', 2, false, null] }],
    profiles: [{ id: 'manual', scope: { connectionId: 'dev' }, overrides: { behavior: { automatic: false } } }]
  }))
  await page.locator('[data-apply-completion-json]').click()
  await expect(page.locator('[data-json-issues]')).toContainText('校验通过')
  await page.locator('[data-save-completion]').click()
  await expect(page.locator('[data-save-state]')).toContainText('已保存')
  await page.locator('[data-back]').click()
  const sql = 'SELECT MASK_ FROM customers'
  await setQuery(page, sql); await editorAction(page, '', 12)
  await page.keyboard.type('N')
  // Wait beyond the configured automatic delay: the connection override wins.
  await page.waitForTimeout(200)
  await expect(page.locator('.suggest-widget.visible')).toHaveCount(0)
  await editorAction(page, 'suggest')
  await expect(labels(page).filter({ hasText: /^MASK_NAME$/ })).toBeVisible()
  await page.keyboard.press('Escape')
  const where = 'SELECT id FROM customers WHERE name = '
  await setQuery(page, where); await editorAction(page, 'suggest', where.length)
  for (const value of ["'001'", '2', 'FALSE', 'NULL']) await expect(labels(page).filter({ hasText: new RegExp(`^${value}$`) })).toBeVisible()
  await labels(page).filter({ hasText: /^'001'$/ }).click()
  await expect.poll(() => editorAction(page)).toBe(`${where}'001'`)
  expect(await editorAction(page, 'undo')).toBe(where)
})

test('table automatic override suppresses the first typed list without disabling other tables', async ({ page }) => {
  await fixture(page)
  await page.evaluate(() => { window.__strictSessionTasks = true })
  await connect(page); await navigate(page, 'settings')
  await page.getByText('自定义函数、枚举和高级配置', { exact: true }).click()
  await page.locator('[data-completion-json]').fill(JSON.stringify({
    profiles: [{ id: 'manual-customers', scope: { connectionId: 'dev', table: 'customers' }, overrides: { behavior: { automatic: false } } }]
  }))
  await page.locator('[data-apply-completion-json]').click()
  await page.locator('[data-save-completion]').click()
  await expect(page.locator('[data-save-state]')).toContainText('已保存')
  await page.locator('[data-back]').click()

  await setQuery(page, 'SELECT c.n FROM customers c;'); await editorAction(page, '', 10)
  await page.keyboard.type('a')
  await expect.poll(() => page.evaluate(() => window.__calls.some(call => call[0] === 'schema.describe' && call[1].table === 'customers'))).toBe(true)
  // Let the metadata-backed response settle beyond the normal automatic delay.
  await page.waitForTimeout(200)
  await expect(page.locator('.suggest-widget.visible')).toHaveCount(0)
  await editorAction(page, 'suggest')
  await expect(labels(page).filter({ hasText: /^name$/ })).toBeVisible()
  await page.keyboard.press('Escape')

  await setQuery(page, 'SELECT p.n FROM products p;'); await editorAction(page, '', 10)
  await page.keyboard.type('a')
  await expect(labels(page).filter({ hasText: /^name$/ })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect.poll(() => editorAction(page)).toBe('SELECT p.name FROM products p;')
})

test('lightweight editor uses table-scoped Enter and Tab acceptance overrides', async ({ page }) => {
  await page.route('**/monaco-*.js', route => route.abort())
  await fixture(page); await connect(page); await navigate(page, 'settings')
  await page.getByText('自定义函数、枚举和高级配置', { exact: true }).click()
  await page.locator('[data-completion-json]').fill(JSON.stringify({
    profiles: [{ id: 'customer-keys', scope: { connectionId: 'dev', table: 'customers' }, overrides: { behavior: { acceptOnEnter: true, acceptOnTab: false } } }]
  }))
  await page.locator('[data-apply-completion-json]').click()
  await page.locator('[data-save-completion]').click()
  await expect(page.locator('[data-save-state]')).toContainText('已保存')
  await page.locator('[data-back]').click()
  const editor = page.locator('textarea[aria-label="查询编辑器"]')
  const popup = page.locator('.completion-popup:not([hidden])')
  const typeColumn = async () => {
    await editor.fill('SELECT c.n FROM customers c;')
    await editor.evaluate(element => { element.focus(); element.setSelectionRange(10, 10) })
    await editor.press('a')
    await expect(popup.locator('.comp-label').filter({ hasText: /^name/ })).toBeVisible()
  }
  await typeColumn(); await editor.press('Enter')
  await expect(editor).toHaveValue('SELECT c.name FROM customers c;')
  await typeColumn(); await editor.press('Tab')
  await expect(editor).toHaveValue('SELECT c.na   FROM customers c;')
})
