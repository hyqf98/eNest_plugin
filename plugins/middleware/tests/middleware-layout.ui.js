import { test, expect } from '@playwright/test'
import { fixture, openConnection, openPage } from './middleware-fixture.js'
import { applyWorkbenchTheme } from '../../../scripts/tests/workbench-theme.js'

for (const scenario of [
  { width: 720, height: 420, theme: 'light', animation: 'low', mode: 'shell' },
  { width: 1024, height: 720, theme: 'light', animation: 'medium', mode: 'shell' },
  { width: 1440, height: 900, theme: 'dark', animation: 'high', mode: 'shell', largeFont: true },
  { width: 480, height: 240, theme: 'light', animation: 'low', mode: 'quick' },
  { width: 720, height: 420, theme: 'dark', animation: 'medium', mode: 'quick' },
]) test(`middleware ${scenario.mode} ${scenario.width}×${scenario.height}: contained layout and caret list`, async ({ page }) => {
  await page.setViewportSize(scenario)
  await fixture(page)
  await applyWorkbenchTheme(page, scenario.theme)
  await page.evaluate(scenario => {
    document.documentElement.dataset.theme = scenario.theme
    document.documentElement.dataset.anim = scenario.animation
    if (scenario.largeFont) document.documentElement.style.fontSize = '18px'
  }, scenario)
  await openConnection(page)
  const messages = await openPage(page, 'messages')
  await messages.getByLabel('消息查询目标').fill('order-events')
  await messages.getByLabel('消息查询目标').press('Escape')
  await messages.getByRole('button', { name: '查询', exact: true }).click()
  await expect(messages.locator('tbody')).toContainText('23942')
  if (scenario.mode === 'quick') {
    await page.evaluate(() => window.__modeChange('quick'))
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'quick')
    const quickMessages = page.locator('[data-page-panel=messages]:visible')
    await quickMessages.getByLabel('消息查询目标').fill('order-events')
    await quickMessages.getByLabel('消息查询目标').press('Escape')
    await quickMessages.getByRole('button', { name: '查询', exact: true }).click()
    await expect(quickMessages.locator('tbody')).toContainText('23942')
  }
  await page.screenshot({ path: `test-results-workbenches/middleware-${scenario.mode}-${scenario.width}-${scenario.theme}.png` })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width)
  const target = page.locator('[data-page-panel=messages]:visible').getByLabel('消息查询目标')
  await target.fill('order'); await target.press('Control+Space')
  const list = page.locator('.mw-suggestions:visible')
  await expect(list).toBeVisible()
  const rect = await list.boundingBox()
  expect(rect.x).toBeGreaterThanOrEqual(0)
  expect(rect.x + rect.width).toBeLessThanOrEqual(scenario.width)
  expect(rect.y + rect.height).toBeLessThanOrEqual(scenario.height)
  await page.screenshot({ path: `test-results-workbenches/middleware-hints-${scenario.mode}-${scenario.width}-${scenario.theme}.png` })
  await target.press('Escape'); await expect(list).toHaveCount(0)
})

test('middleware navigation respects reduced motion and keyboard resize boundaries', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  await fixture(page); await openConnection(page)
  const separator = page.locator('#resizer-tree')
  await separator.focus(); await separator.press('End')
  await expect(separator).toHaveAttribute('aria-valuenow', '360')
  await separator.press('Home'); await expect(separator).toHaveAttribute('aria-valuenow', '220')
  await page.setViewportSize({ width: 480, height: 360 })
  await page.locator('#nav-toggle').click()
  await page.locator('#connection-search').press('Escape')
  await expect(page.locator('#nav-toggle')).toBeFocused()
})
