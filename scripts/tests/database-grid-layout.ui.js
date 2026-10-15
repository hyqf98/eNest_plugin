import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { fixture, connect, setQuery } from './database-fixture.js'

// Headless Chromium otherwise hides scrollbars, which changes sticky gutter
// geometry and cannot represent a user's draggable horizontal scroll track.
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
test.use({ launchOptions: { ...(existsSync(chrome) ? { executablePath: chrome } : {}), ignoreDefaultArgs: ['--hide-scrollbars'] } })

// Realistic wide rows make intrinsic widths, long comments and both scroll axes observable.
async function wideGrid(page, { mode = 'shell', width = 1440, height = 900, delayedMetadata = false } = {}) {
  await page.setViewportSize({ width, height })
  await fixture(page, mode)
  await page.evaluate(({ delayedMetadata }) => {
    const columns = [
      { name: 'id', type: 'BIGINT', primaryKey: true, comment: '订单编号' },
      { name: 'customer_name', type: 'VARCHAR(180)', comment: '客户名称与完整备注：即使字段说明很长也不能挤占其他列的空间' },
      { name: 'amount', type: 'DECIMAL(14,2)', comment: '应付金额' },
      { name: 'enabled', type: 'BOOLEAN', comment: '是否启用' },
      { name: 'created_at', type: 'DATETIME', comment: '创建时间' },
      { name: 'email_address', type: 'VARCHAR(255)', comment: '电子邮箱' },
      { name: 'shipping_address', type: 'TEXT', comment: '完整配送地址' },
      { name: 'quantity', type: 'INTEGER', comment: '购买数量' },
      { name: 'currency', type: 'CHAR(3)', comment: '币种' },
      { name: 'region', type: 'VARCHAR(80)', comment: '业务地区' },
      { name: 'postal_code', type: 'VARCHAR(20)', comment: '邮政编码，前导零需要保留' },
      { name: 'discount_rate', type: 'DOUBLE', comment: '折扣比例' },
      { name: 'notes', type: 'TEXT', comment: '订单备注' },
      { name: 'updated_at', type: 'TIMESTAMP', comment: '更新时间' },
      { name: 'external_reference', type: 'VARCHAR(255)', comment: '外部系统参考编号' },
      { name: 'status', type: 'VARCHAR(32)', comment: '当前订单状态' },
      { name: 'owner_name', type: 'VARCHAR(120)', comment: '负责人' },
      { name: 'last_column_marker', type: 'VARCHAR(120)', comment: '最右侧字段应完整可达' }
    ]
    const rows = Array.from({ length: 140 }, (_, index) => [
      index + 1, `客户 ${String(index + 1).padStart(3, '0')} · 张小明`, (index + 1) * 125.75, index % 2 === 0,
      '2026-10-14 12:34:56', `customer-${index + 1}@example.test`, '上海市浦东新区世纪大道 100 号 · 十一层 A 座',
      index + 2, 'CNY', '华东地区', '001280', 0.875, '较长的订单备注用于检查单元格截断、留白、对齐与悬停说明',
      '2026-10-14 13:02:08', `ORDER-2026-OCTOBER-${String(index + 1).padStart(6, '0')}`, '待发货', '李经理', `END-${index + 1}`
    ])
    const originalExecute = window.enest.db.workbench
    const originalDescribe = window.enest.db.schema.describe
    window.enest.db.schema.describe = async request => {
      const response = { ...await originalDescribe(request), columns }
      if (delayedMetadata && !request.sessionKey.includes(':catalog:')) return new Promise(resolve => { window.__releaseWideMetadata = () => resolve(response) })
      return response
    }
    window.enest.db.workbench = async request => {
      const response = await originalExecute(request)
      if (request.action === 'execute') response.results = [{ columns: delayedMetadata ? columns.map(({ comment: _comment, ...column }) => ({ ...column, type: 123 })) : columns, rows, rowCount: rows.length, editable: true, rowIdentity: { keyColumns: ['id'], keys: rows.map(row => [row[0]]) } }]
      return response
    }
  }, { delayedMetadata })
  await connect(page)
  await setQuery(page, 'SELECT * FROM customers;')
  await page.locator('[data-action=run]').click()
  if (mode === 'quick') await page.locator('[data-expand-results]').click()
  await expect(page.locator('.grid-viewport [data-r="0"][data-c="1"]')).toContainText('客户 001')
}

async function gridMetrics(page, rowIndex = 0) {
  return page.evaluate(async rowIndex => {
    await new Promise(requestAnimationFrame)
    const head = document.querySelector('.grid-head')
    const viewport = document.querySelector('.grid-viewport')
    const row = viewport.querySelector(`[data-row="${rowIndex}"]`)
    const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    return {
      viewport: { ...rect(viewport), clientWidth: viewport.clientWidth, clientHeight: viewport.clientHeight, scrollWidth: viewport.scrollWidth, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop,
        horizontalScrollbar: viewport.offsetHeight - viewport.clientHeight,
        scrollbarWidth: getComputedStyle(viewport).scrollbarWidth,
        scrollbarHeight: getComputedStyle(viewport, '::-webkit-scrollbar').height,
        scrollbarTrack: getComputedStyle(viewport, '::-webkit-scrollbar-track').backgroundColor },
      head: rect(head),
      headers: [...head.querySelectorAll('.head-row [data-c]')].map(rect),
      cells: [...row.querySelectorAll('[data-r][data-c]')].map(rect),
      gutters: ['.sel', '.idx'].map(selector => ({ head: rect(head.querySelector(`.head-row ${selector}`)), cell: rect(row.querySelector(selector)) })),
      status: { head: rect(head.querySelector('.head-row .status')), cell: rect(row.querySelector('.status')) },
      row: rect(row),
      documentWidth: document.documentElement.scrollWidth,
      windowWidth: innerWidth
    }
  }, rowIndex)
}

function expectAligned(metrics) {
  expect(metrics.headers).toHaveLength(18)
  expect(metrics.cells).toHaveLength(18)
  for (let index = 0; index < metrics.headers.length; index++) {
    expect(Math.abs(metrics.headers[index].left - metrics.cells[index].left), `column ${index} left edge`).toBeLessThan(1)
    expect(Math.abs(metrics.headers[index].width - metrics.cells[index].width), `column ${index} width`).toBeLessThan(1)
  }
  expect(Math.abs(metrics.status.head.left - metrics.status.cell.left), 'fixed status left edge').toBeLessThan(1)
  expect(Math.abs(metrics.status.head.width - metrics.status.cell.width), 'fixed status width').toBeLessThan(1)
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.windowWidth + 1)
}

test('wide result columns stay aligned with fixed row controls and the final field remains reachable', async ({ page }) => {
  await wideGrid(page)
  const viewport = page.locator('.grid-viewport')
  const divider = await page.locator('#resizer-bottom').boundingBox()
  const resultsHeight = await page.locator('#results').evaluate(element => element.getBoundingClientRect().height)
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2)
  await page.mouse.down(); await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2 - (380 - resultsHeight), { steps: 6 }); await page.mouse.up()
  await expect.poll(() => page.locator('#results').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(370)
  for (const [width, height] of [[1440, 900], [1024, 768], [720, 620]]) {
    await page.setViewportSize({ width, height })
    await viewport.evaluate(element => { element.scrollLeft = 0 })
    await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBe(0)
    const before = await gridMetrics(page)
    await test.info().attach(`grid-metrics-${width}`, { body: JSON.stringify(before, null, 2), contentType: 'application/json' })
    expect(before.viewport.scrollWidth).toBeGreaterThan(before.viewport.clientWidth + 500)
    expect(before.viewport.horizontalScrollbar, 'dedicated horizontal scrollbar track remains reachable').toBeGreaterThanOrEqual(8)
    expect(parseFloat(before.viewport.scrollbarHeight)).toBeGreaterThanOrEqual(8)
    expect(before.viewport.scrollbarTrack).not.toBe('rgba(0, 0, 0, 0)')
    expectAligned(before)
    if (width === 1440) {
      await page.mouse.move(width - 5, 5)
      await expect.poll(() => page.locator('.enest-float-tip').evaluateAll(elements => elements.every(element => getComputedStyle(element).opacity === '0'))).toBe(true)
      await page.screenshot({ path: 'test-results-db/database-grid-wide-1440-start.png' })
    }
    await viewport.evaluate(element => { element.scrollLeft = element.scrollWidth })
    await expect.poll(async () => (await gridMetrics(page)).viewport.scrollLeft).toBeGreaterThan(500)
    const after = await gridMetrics(page)
    expectAligned(after)
    for (let index = 0; index < before.gutters.length; index++) {
      expect(Math.abs(after.gutters[index].cell.left - before.gutters[index].cell.left)).toBeLessThan(1)
      expect(Math.abs(after.gutters[index].head.left - before.gutters[index].head.left)).toBeLessThan(1)
      expect(Math.abs(after.gutters[index].cell.left - after.gutters[index].head.left)).toBeLessThan(1)
    }
    await expect(viewport.locator('[data-r="0"][data-c="17"]')).toBeInViewport({ ratio: 1 })
    expect(after.cells[17].right).toBeLessThanOrEqual(after.viewport.left + after.viewport.clientWidth + 1)
    await page.mouse.move(width - 5, 5)
    await page.screenshot({ path: `test-results-db/database-grid-wide-${width}.png` })
  }
})

test('field comments truncate cleanly and filter cells share the exact data-column geometry', async ({ page }) => {
  await wideGrid(page)
  const header = page.locator('.head-row [data-c="1"]')
  await expect(header).toHaveAttribute('title', /完整备注/)
  const typography = await header.evaluate(element => {
    const comment = element.querySelector('.rg-column-comment'), label = element.querySelector('.rg-column-name')
    const cs = getComputedStyle(comment)
    return { overflow: cs.overflow, ellipsis: cs.textOverflow, whiteSpace: cs.whiteSpace, labelWidth: label.getBoundingClientRect().width, commentWidth: comment.getBoundingClientRect().width }
  })
  expect(typography).toMatchObject({ overflow: 'hidden', ellipsis: 'ellipsis', whiteSpace: 'nowrap' })
  expect(typography.labelWidth).toBeGreaterThan(24)
  expect(typography.commentWidth).toBeGreaterThan(12)
  await page.locator('[data-el=filterToggle]').click()
  await expect(page.locator('[data-filter-c="1"]')).toBeVisible()
  await page.locator('.grid-viewport').evaluate(element => { element.scrollLeft = 437 })
  const deltas = await page.locator('.grid-head').evaluate(element => [...element.querySelectorAll('.head-row [data-c]')].map(header => {
    const filter = element.querySelector(`[data-fc="${header.dataset.c}"]`)
    const h = header.getBoundingClientRect(), f = filter.getBoundingClientRect()
    return { left: Math.abs(h.left - f.left), width: Math.abs(h.width - f.width) }
  }))
  for (const delta of deltas) { expect(delta.left).toBeLessThan(1); expect(delta.width).toBeLessThan(1) }
  expectAligned(await gridMetrics(page))
  await page.locator('.grid-viewport').evaluate(element => { element.scrollLeft = 0 })
  await page.locator('[data-filter-c="17"]').focus()
  await expect.poll(() => page.locator('.grid-viewport').evaluate(element => element.scrollLeft)).toBeGreaterThan(500)
  expectAligned(await gridMetrics(page))
})

test('horizontal scrolling preserves the active editor and its selection without staging the edit', async ({ page }) => {
  await wideGrid(page)
  await page.locator('[data-r="0"][data-c="1"]').dblclick()
  const editor = page.locator('.cell-editor')
  await editor.fill('输入中，还没有确认的客户名称')
  await editor.evaluate(element => element.setSelectionRange(2, 7))
  await page.locator('.grid-viewport').evaluate(element => { element.scrollLeft = 260 })
  await expect.poll(() => page.locator('.grid-viewport').evaluate(element => element.scrollLeft)).toBe(260)
  await expect(editor).toBeVisible()
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue('输入中，还没有确认的客户名称')
  expect(await editor.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([2, 7])
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue('输入中，还没有确认的客户名称')
  expect(await editor.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([2, 7])
  await expect(page.locator('.row-dirty')).toHaveCount(0)
  await editor.press('Escape')
  await page.locator('.grid-viewport').evaluate(element => { element.scrollLeft = 0 })
  await expect(page.locator('[role=gridcell][data-r="0"][data-c="1"]')).toContainText('客户 001')
  expect(await page.evaluate(() => window.__calls.some(call => call[0] === 'applyChanges'))).toBe(false)
})

test('column resizing is keyboard accessible and widths plus scroll positions survive switching tabs', async ({ page }) => {
  await wideGrid(page)
  const sourceId = await page.locator('#workspace-tabs [role=tab][aria-selected=true]').getAttribute('data-workspace-tab')
  const resize = page.locator('[data-resize-column="1"]')
  await expect(resize).toHaveAttribute('role', 'separator')
  const header = page.locator('.head-row [data-c="1"]')
  const beforeWidth = await header.evaluate(element => element.getBoundingClientRect().width)
  const handle = await resize.boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2 + 84, handle.y + handle.height / 2, { steps: 8 }); await page.mouse.up()
  await expect.poll(() => header.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(beforeWidth + 75)
  await expect(header).toHaveAttribute('aria-sort', 'none')
  await resize.focus(); await resize.press('ArrowRight')
  const chosenWidth = await header.evaluate(element => element.getBoundingClientRect().width)
  await page.locator('.grid-viewport').evaluate(element => { element.scrollLeft = 460; element.scrollTop = 840 })
  await expect.poll(() => page.locator('.grid-viewport').evaluate(element => element.scrollTop)).toBe(840)
  await connect(page, 'analytics')
  await page.locator(`#workspace-tabs [role=tab][data-workspace-tab="${sourceId}"]`).click()
  await expect.poll(() => page.locator('.grid-viewport').evaluate(element => element.scrollLeft)).toBe(460)
  await expect.poll(() => page.locator('.grid-viewport').evaluate(element => element.scrollTop)).toBe(840)
  expect(Math.abs(await header.evaluate(element => element.getBoundingClientRect().width) - chosenWidth)).toBeLessThan(1)
  await page.setViewportSize({ width: 1024, height: 768 })
  expect(Math.abs(await header.evaluate(element => element.getBoundingClientRect().width) - chosenWidth)).toBeLessThan(1)
  await page.locator('.grid-viewport').evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0 })
  await resize.focus(); await resize.press('Home')
  await expect.poll(() => header.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(chosenWidth - 20)
})

test('dark enlarged-font wide rows keep correct virtual height and stable numeric alignment', async ({ page }) => {
  await wideGrid(page, { width: 1024, height: 768 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.setProperty('--font-size-base', '16.9px') })
  const metric = page.locator('[data-el=rowMetric]')
  await expect.poll(() => metric.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(33)
  const rowHeight = await metric.evaluate(element => element.getBoundingClientRect().height)
  await page.locator('.grid-viewport').evaluate((element, rowHeight) => { element.scrollTop = 50 * rowHeight; element.scrollLeft = 190 }, rowHeight)
  await expect(page.locator('[data-row="50"]')).toBeVisible()
  const dimensions = await gridMetrics(page, 50)
  expectAligned(dimensions)
  expect(Math.abs(dimensions.row.height - rowHeight)).toBeLessThan(1)
  expect(Math.abs(await page.locator('.grid-canvas').evaluate(element => element.getBoundingClientRect().height) - 140 * rowHeight)).toBeLessThan(1)
  const alignment = await page.locator('[data-r="50"][data-c="2"]').evaluate(element => getComputedStyle(element).justifyContent)
  expect(['end', 'flex-end', 'right']).toContain(alignment)
  await page.mouse.move(1000, 5)
  await page.screenshot({ path: 'test-results-db/database-grid-wide-dark-font-130.png' })
})

test('late declared column types align existing values and a live editor without resetting its input', async ({ page }) => {
  await wideGrid(page, { delayedMetadata: true })
  await expect.poll(() => page.evaluate(() => typeof window.__releaseWideMetadata)).toBe('function')
  const cell = page.locator('[role=gridcell][data-r="0"][data-c="2"]')
  await expect(cell).toHaveClass(/align-text/)
  await cell.dblclick()
  const editor = page.locator('.cell-editor')
  await editor.fill('1234.56')
  await editor.evaluate(element => element.setSelectionRange(1, 4))
  await page.evaluate(() => window.__releaseWideMetadata())
  await expect(cell).toHaveClass(/align-numeric/)
  await expect(page.locator('.head-row [data-c="2"]')).toHaveClass(/align-numeric/)
  await expect(editor).toHaveAttribute('data-alignment', 'numeric')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue('1234.56')
  expect(await editor.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([1, 4])
  await expect(page.locator('.row-dirty')).toHaveCount(0)
  expectAligned(await gridMetrics(page))
})

test('Quick wide results keep a reachable horizontal scrollbar and paging at both supported compact sizes', async ({ page }) => {
  await wideGrid(page, { mode: 'quick', width: 480, height: 240 })
  for (const [width, height, theme] of [[480, 240, 'dark'], [720, 420, 'light']]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    const viewport = page.locator('.grid-viewport')
    await viewport.evaluate(element => { element.scrollLeft = element.scrollWidth })
    await expect(viewport.locator('[data-r="0"][data-c="17"]')).toBeInViewport({ ratio: 1 })
    const metrics = await gridMetrics(page)
    expectAligned(metrics)
    expect(metrics.viewport.clientHeight).toBeGreaterThanOrEqual(26)
    const lastCompleteRow = Math.max(0, Math.floor(metrics.viewport.clientHeight / metrics.row.height) - 1)
    await expect(viewport.locator(`[data-row="${lastCompleteRow}"] [data-c="17"]`)).toBeInViewport({ ratio: 1 })
    expect(metrics.viewport.bottom).toBeLessThan(height)
    await expect(page.locator('.rg-pager')).toBeInViewport({ ratio: 1 })
    await expect(page.locator('.wb-status')).toBeInViewport({ ratio: 1 })
    expect(await page.evaluate(() => window.__calls.some(call => call[0] === 'applyChanges'))).toBe(false)
    await page.mouse.move(width - 5, 5)
    await page.screenshot({ path: `test-results-db/database-grid-wide-quick-${width}-${theme}.png` })
  }
})
