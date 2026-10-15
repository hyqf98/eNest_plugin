import { test, expect } from '@playwright/test'
import { fixture, connect, navigate, setQuery } from './database-fixture.js'

async function openQuerySettings(page, sql) {
  await fixture(page); await connect(page); await setQuery(page, sql); await navigate(page, 'settings')
  await expect(page.locator('[data-import-query-set]')).toBeVisible()
}

test('current SELECT creates a scoped field group without executing SQL and preserves its physical column order', async ({ page }) => {
  await openQuerySettings(page, 'SELECT c.name AS display_name, c.id FROM customers c;')
  await page.locator('[data-import-query-set]').click()
  await expect(page.locator('[data-query-set-state]')).toContainText('已提取 2 个字段')
  await expect(page.locator('[data-manual-columns]')).toHaveValue('name, id')
  await expect(page.locator('[data-set-scope=connectionId]')).toHaveValue('dev')
  await expect(page.locator('[data-set-scope=table]')).toHaveValue('customers')
  await page.locator('[data-save-completion]').click()
  await expect(page.locator('[data-save-state]')).toContainText('已保存')
  const group = await page.evaluate(() => window.__data['db.ui'].completion.columnSets[0])
  expect(group.scope).toMatchObject({ connectionId: 'dev', database: 'orders', table: 'customers' })
  expect(group.columns).toEqual(['name', 'id'])
  expect(await page.evaluate(() => window.__calls.filter(call => call[0] === 'execute').length)).toBe(0)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
})

test('extracting an expression query reports why it cannot be a field group and leaves existing drafts intact', async ({ page }) => {
  await openQuerySettings(page, 'SELECT id, UPPER(name) AS label FROM customers;')
  await page.locator('[data-new-set]').click()
  await page.locator('[data-set-field=label]').fill('已维护的字段')
  await page.locator('[data-set-scope=table]').fill('customers')
  await page.locator('[data-manual-columns]').fill('name'); await page.locator('[data-manual-columns]').press('Tab')
  await page.locator('[data-import-query-set]').click()
  await expect(page.locator('[data-query-set-state]')).toContainText('计算表达式')
  await expect(page.locator('[data-set-field=label]')).toHaveValue('已维护的字段')
  await expect(page.locator('[data-manual-columns]')).toHaveValue('name')
  await expect(page.locator('[data-select-set]')).toHaveCount(1)
})

test('field order supports captured pointer dragging, Escape cancellation and keyboard reorder', async ({ page }) => {
  await openQuerySettings(page, 'SELECT name, id FROM customers;')
  await page.locator('[data-import-query-set]').click()
  await expect(page.locator('[data-manual-columns]')).toHaveValue('name, id')
  await page.locator('[data-manual-columns]').fill('name, id, status'); await page.locator('[data-manual-columns]').press('Tab')
  const first = page.locator('[data-drag-column="0"]'), last = page.locator('[data-column-order-row="2"]')
  await first.scrollIntoViewIfNeeded()
  const a = await first.boundingBox(), b = await last.boundingBox()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down()
  await page.mouse.move(b.x + 10, b.y + b.height - 1, { steps: 4 }); await page.mouse.up()
  await expect(page.locator('[data-manual-columns]')).toHaveValue('id, status, name')
  await page.locator('[data-drag-column="2"]').press('Home')
  await expect(page.locator('[data-manual-columns]')).toHaveValue('name, id, status')
  const start = await first.boundingBox()
  await page.mouse.move(start.x + 8, start.y + 8); await page.mouse.down(); await page.mouse.move(start.x + 8, start.y + 75)
  await page.keyboard.press('Escape'); await page.mouse.up()
  await expect(page.locator('[data-manual-columns]')).toHaveValue('name, id, status')
  await expect(page.locator('.sql-column-order .dragging')).toHaveCount(0)
})

test('a late field read cannot create a group after its source document changes', async ({ page }) => {
  await fixture(page)
  await page.evaluate(() => {
    const describe = enest.db.schema.describe
    enest.db.schema.describe = async request => {
      await new Promise(resolve => { window.__releaseColumns = resolve })
      return describe(request)
    }
  })
  await connect(page); await setQuery(page, 'SELECT name FROM customers;'); await navigate(page, 'settings')
  await page.locator('[data-import-query-set]').click()
  await expect.poll(() => page.evaluate(() => typeof window.__releaseColumns)).toBe('function')
  await page.evaluate(async () => {
    const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name)
    monaco.editor.getEditors()[0].setValue('SELECT id FROM customers;')
    window.__releaseColumns()
  })
  await expect(page.locator('[data-query-set-state]')).toContainText('来源查询或连接已变化')
  await expect(page.locator('[data-select-set]')).toHaveCount(0)
})

test('field group metadata honors an empty schema and another connection default database', async ({ page }) => {
  await fixture(page)
  await page.evaluate(() => {
    window.__data['db.connections'][0].schema = 'public'
    sessionStorage.setItem('database-fixture-storage', JSON.stringify(window.__data))
  })
  await page.reload(); await connect(page); await navigate(page, 'settings')
  await page.getByText('自定义函数、枚举和高级配置', { exact: true }).click()
  await page.locator('[data-completion-json]').fill(JSON.stringify({ columnSets: [
    { id: 'empty', label: '无 Schema', scope: { connectionId: 'dev', schema: null, table: 'customers' }, columns: ['name'] },
    { id: 'other', label: '分析连接默认库', scope: { connectionId: 'analytics', table: 'customers' }, columns: ['name'] }
  ] }))
  await page.locator('[data-apply-completion-json]').click()
  await expect(page.locator('[data-json-issues]')).toContainText('校验通过')
  await page.locator('[data-load-columns]').click()
  await expect(page.locator('[data-column-state]')).toContainText('已读取')
  expect(await page.evaluate(() => window.__calls.filter(call => call[0] === 'schema.describe').at(-1)[1].schema || '')).toBe('')
  await page.locator('[data-select-set=other]').click()
  await page.locator('[data-load-columns]').click()
  await expect(page.locator('[data-column-state]')).toContainText('已读取')
  expect(await page.evaluate(() => window.__calls.filter(call => call[0] === 'schema.describe').at(-1)[1].database)).toBe('telemetry')
  expect(await page.evaluate(() => window.__calls.filter(call => call[0] === 'execute').length)).toBe(0)
})
