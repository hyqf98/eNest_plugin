import { test, expect } from '@playwright/test'
import { fixture, connect, setQuery } from './database-fixture.js'

async function gridFixture(page, readOnly = false, delayMetadata = false) {
  await fixture(page)
  await page.evaluate(({ readOnly, delayMetadata }) => {
    const columns = [{ name: 'id', type: 'INTEGER', primaryKey: true, comment: '唯一标识' }, { name: 'name', type: 'TEXT', comment: '客户姓名及展示名称：完整注释应可悬停查看，不应挤出单行表头', nullable: true }, { name: 'enabled', type: 'BOOLEAN', comment: '是否启用', nullable: false }]
    const execute = window.enest.db.workbench, describe = window.enest.db.schema.describe
    window.enest.db.schema.describe = async request => {
      const result = { ...await describe(request), columns }
      if (delayMetadata && !request.sessionKey.includes(':catalog:')) return new Promise(resolve => { window.__releaseGridMetadata = () => resolve(result) })
      return result
    }
    window.enest.db.workbench = async request => {
      const result = await execute(request)
      if (request.action === 'execute') result.results = [{ columns: delayMetadata ? columns.map(({ comment: _comment, ...column }) => column) : columns, rows: [[1, 'Alpha', true], [2, 'Beta', false], [3, 'Gamma', true]], rowCount: 3, editable: !readOnly, rowIdentity: { keyColumns: ['id'], keys: [[1], [2], [3]] } }]
      return result
    }
    window.enest.clipboard.writeText = async text => { window.__clipboardText = text; return true }
  }, { readOnly, delayMetadata })
  await connect(page); await setQuery(page, 'SELECT id, name, enabled FROM customers;')
  await page.locator('[data-action=run]').click()
  await expect(page.locator('.grid-viewport')).toContainText('Alpha')
}

async function paste(page, text) {
  await page.locator('.grid-viewport').evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  }, text)
}

test('headers show compact field comments and column menus copy, sort and filter loaded values', async ({ page }) => {
  await gridFixture(page)
  const name = page.locator('.head-row [data-c="1"]')
  await expect(name.locator('.rg-column-name')).toHaveText('name')
  await expect(name.locator('.rg-column-comment')).toContainText('客户姓名')
  await expect(name).toHaveAttribute('title', /完整注释应可悬停查看/)
  const dimensions = await name.evaluate(element => ({ header: element.getBoundingClientRect().height, comment: element.querySelector('.rg-column-comment').getBoundingClientRect().height }))
  expect(dimensions.comment).toBeLessThan(dimensions.header)
  await name.click({ button: 'right' }); await page.locator('.ctx-menu [data-k=copy-name]').click()
  await expect.poll(() => page.evaluate(() => window.__clipboardText)).toBe('name')
  await name.click({ button: 'right' }); await page.locator('.ctx-menu [data-k=desc]').click()
  await expect(page.locator('.grid-canvas .tr').first()).toHaveAttribute('data-row', '2')
  await name.click({ button: 'right' }); await page.locator('.ctx-menu [data-k=filter]').click()
  await page.locator('[data-filter-c="1"]').fill('Beta')
  await expect(page.locator('.grid-canvas .tr')).toHaveCount(1)
  await expect(page.locator('.grid-viewport')).toContainText('Beta')
})

test('batch editing selected rows stays local, can undo and survives a tab switch', async ({ page }) => {
  await gridFixture(page)
  const source = await page.locator('#workspace-tabs [aria-selected=true]').getAttribute('data-workspace-tab')
  await page.locator('[data-row="0"] .row-check').check()
  await page.locator('[data-row="1"] .row-check').check()
  await page.locator('[data-sel=batch]').click()
  await page.locator('[data-batch-column]').selectOption('1')
  await page.locator('[data-batch-value]').fill('Batch customer')
  await page.locator('[data-batch-apply]').click()
  await expect(page.locator('.row-dirty')).toHaveCount(2)
  await expect(page.locator('.grid-viewport')).toBeFocused()
  expect(await page.evaluate(() => window.__calls.some(call => call[0] === 'applyChanges'))).toBe(false)
  await page.keyboard.press('Meta+z')
  await expect(page.locator('.row-dirty')).toHaveCount(0)
  await page.keyboard.press('Meta+Shift+z')
  await expect(page.locator('.row-dirty')).toHaveCount(2)
  await connect(page, 'analytics')
  await page.locator(`#workspace-tabs [role=tab][data-workspace-tab="${source}"]`).click()
  await expect(page.locator('[data-r="0"][data-c="1"]')).toHaveText('Batch customer')
  await expect(page.locator('.row-dirty')).toHaveCount(2)
  await page.locator('[data-r="0"][data-c="1"]').click({ button: 'right' })
  await page.locator('.ctx-menu [data-k=revert-selected]').click()
  await expect(page.locator('.row-dirty')).toHaveCount(0)
})

test('TSV paste validates the entire area, navigation follows cells and copied rows include pending values', async ({ page }) => {
  await gridFixture(page)
  await page.locator('[data-r="0"][data-c="1"]').click()
  await paste(page, 'First pasted\tfalse\nSecond pasted\ttrue')
  await expect(page.locator('[data-r="0"][data-c="1"]')).toHaveText('First pasted')
  await expect(page.locator('[data-r="1"][data-c="2"]')).toHaveText('true')
  await paste(page, 'must stay atomic\tnot-a-boolean')
  await expect(page.locator('[data-r="0"][data-c="1"]')).toHaveText('First pasted')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-r="1"][data-c="1"]')).toHaveClass(/cell-active/)
  await page.keyboard.press('Shift+Space')
  await page.keyboard.press('Meta+c')
  await expect.poll(() => page.evaluate(() => window.__clipboardText)).toBe('2\tSecond pasted\ttrue')
  await page.keyboard.press('F2')
  await expect(page.locator('.cell-editor')).toHaveValue('Second pasted')
  await page.locator('.cell-editor').fill('Edited with keyboard')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-r="1"][data-c="1"]')).toHaveText('Edited with keyboard')
})

test('copying multiple rows clears primary keys, deleting inserted rows and undo remain local', async ({ page }) => {
  await gridFixture(page)
  await page.locator('[data-row="0"] .row-check').check(); await page.locator('[data-row="1"] .row-check').check()
  await page.locator('[data-r="0"][data-c="1"]').click({ button: 'right' })
  await page.locator('.ctx-menu [data-k=dup]').click()
  await expect(page.locator('.row-inserted')).toHaveCount(2)
  await expect(page.locator('.row-inserted [data-c="0"]').first()).toHaveText('NULL')
  await page.locator('[data-sel=delete]').click()
  await expect(page.locator('.row-inserted')).toHaveCount(0)
  await page.locator('.grid-viewport').focus(); await page.keyboard.press('Meta+z')
  await expect(page.locator('.row-inserted')).toHaveCount(2)
  expect(await page.evaluate(() => window.__calls.some(call => call[0] === 'applyChanges'))).toBe(false)
})

test('read-only results reject clipboard edits and hide destructive context actions', async ({ page }) => {
  await gridFixture(page, true)
  await page.locator('[data-r="0"][data-c="1"]').click()
  await paste(page, 'must not change')
  await expect(page.locator('[data-r="0"][data-c="1"]')).toHaveText('Alpha')
  await page.locator('[data-r="0"][data-c="1"]').click({ button: 'right' })
  await expect(page.locator('.ctx-menu [data-k=delete]')).toHaveCount(0)
  await expect(page.locator('.ctx-menu [data-k=batch]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.locator('.grid-viewport').focus(); await page.keyboard.press('Shift+Space'); await page.keyboard.press('Delete')
  await expect(page.locator('.row-deleted')).toHaveCount(0)
})

test('late field descriptions update headers without committing or interrupting a live cell editor', async ({ page }) => {
  await gridFixture(page, false, true)
  await expect.poll(() => page.evaluate(() => typeof window.__releaseGridMetadata)).toBe('function')
  await page.locator('[data-r="0"][data-c="1"]').dblclick()
  const editor = page.locator('.cell-editor')
  await editor.fill('Still typing this value')
  await editor.evaluate(element => element.setSelectionRange(3, 11))
  await page.evaluate(() => window.__releaseGridMetadata())
  await expect(page.locator('.head-row [data-c="1"] .rg-column-comment')).toContainText('客户姓名')
  await expect(editor).toBeVisible(); await expect(editor).toBeFocused()
  await expect(editor).toHaveValue('Still typing this value')
  expect(await editor.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([3, 11])
  await expect(page.locator('.row-dirty')).toHaveCount(0)
  await editor.press('Enter')
  await expect(page.locator('[data-r="0"][data-c="1"]')).toHaveText('Still typing this value')
  await expect(page.locator('.row-dirty')).toHaveCount(1)
})
