import { test, expect } from '@playwright/test'
import { fixture, connect, setQuery } from './database-fixture.js'

async function setup(page) {
  await fixture(page)
  await page.evaluate(() => {
    const read = window.enest.db.schema.describe
    window.enest.db.schema.describe = async request => ({ ...await read(request), columns: [{ name: 'id', type: 'INT', primaryKey: true, comment: '客户编号' }, { name: 'name', type: 'VARCHAR(255)', nullable: true, comment: '客户名称：用于订单和账单显示的完整名称' }] })
    window.enest.clipboard.writeText = async text => { window.__copied = text; return true }
  })
  await connect(page); await setQuery(page, 'SELECT id, name FROM customers;')
  await page.locator('[data-action=run]').click()
  await expect(page.locator('.grid-viewport')).toContainText('阿尔法')
}
async function edit(page, row, value) {
  await page.locator(`[data-r="${row}"][data-c="1"]`).dblclick()
  await page.locator('.cell-editor').fill(value); await page.locator('.cell-editor').press('Enter')
}
async function rollback(page) {
  const button = page.locator('[data-action=rollback]')
  if (await button.isVisible()) await button.click()
  else { await page.locator('[data-action=more]').click(); await page.locator('.ctx-menu [data-k=rollback]').click() }
}
async function submit(page) {
  await page.locator('[data-sel=commit]').click()
  await page.locator('dialog [data-confirm]').click()
}
async function exportDialog(page) {
  await page.locator('[data-sel=more]').click()
  await page.locator('.ctx-menu [data-k=export]').click()
}

test('result comments are hydrated independently without resetting pending cell edits', async ({ page }) => {
  await setup(page)
  await expect(page.locator('.head-row [data-c="1"]')).toHaveAttribute('title', /客户名称.*完整名称/s)
  await edit(page, 0, '本地姓名')
  await expect(page.locator('[data-r="0"][data-c="1"]')).toHaveText('本地姓名')
  const calls = await page.evaluate(() => window.__calls.filter(call => call[0] === 'schema.describe'))
  expect(calls.every(call => call[1].sessionKey.startsWith('db-nav:'))).toBe(true)
  await page.screenshot({ path: 'test-results-db/database-productivity-grid.png' })
})

test('manual transaction stages mixed edits, removes deletes and protects local edits before rollback', async ({ page }) => {
  await setup(page)
  await page.locator('[data-action=begin]').click()
  await edit(page, 0, '事务内姓名')
  await page.locator('[data-row="1"] .row-check').check()
  await page.locator('[data-sel=delete]').click()
  await page.locator('[data-sel=insert]').click()
  await edit(page, 2, '新增客户')
  await page.locator('[data-sel=commit]').click()
  await expect(page.locator('dialog')).toContainText('保留事务中此前的操作')
  await page.locator('dialog [data-confirm]').click()
  await expect(page.locator('.wb-status')).toContainText('3 项待提交')
  await expect(page.locator('[data-row="1"]')).toHaveCount(0)
  await expect(page.locator('[data-row="2"]')).toContainText('已写入·待刷新')
  await expect(page.locator('.row-dirty, .row-inserted, .row-deleted')).toHaveCount(0)
  expect(await page.evaluate(() => window.__calls.filter(call => call[0] === 'transaction').map(call => call[1].operation))).toEqual(['begin'])
  await edit(page, 0, '尚未写入事务')
  await rollback(page)
  await expect(page.locator('#local-toast')).toContainText('本地待提交')
  await expect(page.locator('[data-r="0"][data-c="1"]')).toHaveText('尚未写入事务')
  await page.locator('[data-sel=revert]').click()
  await page.screenshot({ path: 'test-results-db/database-productivity-transaction.png' })
  await rollback(page)
  await expect(page.locator('.wb-status')).not.toContainText('待提交')
  await expect(page.locator('#results')).toBeHidden()
})

test('atomic batch failure keeps failed and unattempted changes available for correction', async ({ page }) => {
  await setup(page)
  await edit(page, 0, '回滚后保留'); await edit(page, 1, '尚未尝试')
  await page.evaluate(() => { window.enest.db.applyChanges = async input => { window.__calls.push(['applyChanges', input]); return { ok: false, results: [{ index: 0, ok: false, error: '唯一键冲突；批次已回滚' }] } } })
  await submit(page)
  await expect.poll(() => page.evaluate(() => window.__toasts.some(item => item.message?.includes('批次已回滚')))).toBe(true)
  await expect(page.locator('[data-r="0"][data-c="1"]')).toHaveText('回滚后保留')
  await expect(page.locator('[data-r="1"][data-c="1"]')).toHaveText('尚未尝试')
  await expect(page.locator('[data-sel=commit]')).toBeVisible()
  expect(await page.evaluate(() => window.__calls.find(call => call[0] === 'applyChanges')[1].mode)).toBe('stop-on-error')
})

test('export selection and columns uses local values and never fetches missing server pages', async ({ page }) => {
  await setup(page); await edit(page, 0, '带逗号,新名字')
  await page.locator('[data-row="0"] .row-check').check()
  await exportDialog(page)
  await page.locator('[data-export-scope]').selectOption('selected')
  await page.locator('.db-export-columns summary').click()
  await page.locator('[data-export-column="0"]').uncheck()
  await page.locator('[data-export-name]').fill('selected-customers')
  await expect(page.locator('[data-export-summary]')).toContainText('1 行 · 1 列')
  await expect(page.locator('dialog')).toContainText('本地修改')
  await page.screenshot({ path: 'test-results-db/database-productivity-export.png' })
  await page.locator('[data-f=csv]').click()
  const file = await page.evaluate(() => window.__calls.find(call => call[0] === 'saveTextFile')[1])
  expect(file.defaultName).toBe('selected-customers.csv')
  expect(file.content).toBe('\uFEFFname\r\n"带逗号,新名字"')
  await exportDialog(page)
  await page.locator('[data-f=sql-copy]').click()
  await expect.poll(() => page.evaluate(() => window.__copied)).toContain('INSERT INTO `orders`.`customers`')
  expect(await page.evaluate(() => window.__calls.filter(call => call[0] === 'table.page').length)).toBe(0)
})

for (const sql of ['ROLLBACK;', 'ABORT;', 'ROLLBACK TO SAVEPOINT example;']) test(`${sql} invalidates stale values and keeps transaction status truthful`, async ({ page }) => {
  await setup(page)
  await page.locator('[data-action=begin]').click()
  await edit(page, 0, '已写入事务'); await submit(page)
  await expect(page.locator('.wb-status')).toContainText('1 项待提交')
  await page.evaluate(() => {
    const execute = window.enest.db.workbench
    window.enest.db.workbench = async input => { const response = await execute(input); if (input.action === 'execute' && /^(ROLLBACK|ABORT)/.test(input.input.sql)) response.results = [{ columns: [], rows: [], transactionActive: input.input.sql.includes(' TO ') }]; return response }
  })
  await setQuery(page, sql)
  await page.locator('[data-action=run]').click()
  if (sql.includes(' TO ')) await expect(page.locator('.wb-status')).toContainText('部分回滚')
  else await expect(page.locator('.wb-status')).not.toContainText('待提交')
  await expect(page.locator('.grid-viewport')).not.toContainText('已写入事务')
  await expect(page.locator('#editor-host textarea.ta')).toHaveValue(sql)
})

test('partial multi-statement failures reconcile transaction ownership and protect its last tab', async ({ page }) => {
  await setup(page)
  const source = await page.locator('#workspace-tabs [role=tab][aria-selected=true]').getAttribute('data-workspace-tab')
  await page.evaluate(() => {
    const execute = window.enest.db.workbench
    window.enest.db.listSessions = async () => Object.keys(window.__sessions).map(sessionKey => ({ sessionKey, transactionActive: !!window.__transactionActive }))
    window.enest.db.workbench = async request => {
      if (request.action === 'execute' && request.input.sql.includes('missing_column')) { window.__transactionActive = request.input.sql.startsWith('BEGIN'); throw new Error('no such column: missing_column') }
      return execute(request)
    }
  })
  await page.locator('[data-wb=newQuery]').click()
  const second = await page.locator('#workspace-tabs [role=tab][aria-selected=true]').getAttribute('data-workspace-tab')
  await setQuery(page, 'BEGIN; SELECT missing_column FROM customers;')
  await page.keyboard.press('Meta+Shift+Enter')
  await expect(page.locator('.grid-viewport')).toContainText('no such column')
  await expect(page.locator('.wb-status')).toContainText('事务进行中')
  await page.locator(`[data-close-tab="${source}"]`).click()
  await expect(page.locator(`#workspace-tabs [role=tab][data-workspace-tab="${source}"]`)).toHaveCount(0)
  await page.locator(`[data-close-tab="${second}"]`).click()
  await expect(page.locator('#local-toast')).toContainText('提交或回滚')
  await setQuery(page, 'ROLLBACK; SELECT missing_column FROM customers;')
  await page.keyboard.press('Meta+Shift+Enter')
  await expect(page.locator('.wb-status')).not.toContainText('事务进行中')
  await expect(page.locator('.grid-viewport')).toContainText('no such column')
  await page.locator(`[data-close-tab="${second}"]`).click()
  await expect(page.locator(`#workspace-tabs [role=tab][data-workspace-tab="${second}"]`)).toHaveCount(0)
})

test('empty selected export never changes to exporting all other rows', async ({ page }) => {
  await setup(page)
  await page.locator('[data-row="0"] .row-check').check()
  await page.locator('[data-sel=delete]').click()
  await page.locator('[data-row="0"] .row-check').check()
  await page.locator('[data-r="0"][data-c="1"]').click({ button: 'right' })
  await page.locator('.ctx-menu [data-k=export-selected]').click()
  await expect(page.locator('[data-export-scope]')).toHaveValue('selected')
  await expect(page.locator('[data-export-summary]')).toContainText('0 行')
  await expect(page.locator('[data-f=csv]')).toBeDisabled()
  expect(await page.evaluate(() => window.__calls.some(call => call[0] === 'saveTextFile'))).toBe(false)
})
