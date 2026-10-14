import { test, expect } from '@playwright/test'
import { installPreviewFixture } from '../preview-fixture.mjs'
const cases = [
  ['hash', '#hash-drop'], ['image-tools', '#empty-add'], ['qrcode', '#choose-files'],
  ['color-picker', '#open-image'], ['screen-assistant', '#import-image']
]
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jStsAAAAASUVORK5CYII='
for (const [id, button] of cases) {
  test(`${id}: file import reads only authorized host bytes and handles cancellation/denial`, async ({ page }) => {
    await page.addInitScript(installPreviewFixture, { pluginId: `com.enest.${id}`, mode: 'shell' })
    await page.addInitScript(({ pixel }) => {
      window.__fileMode = 'cancel'; window.__fileCalls = []
      const original = window.enest
      window.enest = new Proxy(original, { get(target, key) {
        if (key !== 'localFiles') return target[key]
        return {
          pick: async options => {
            window.__fileCalls.push(['pick', options])
            if (window.__fileMode === 'deny') throw new Error('fs.read permission denied')
            return window.__fileMode === 'cancel' ? [] : [{ id: 'allowed-file', name: 'sample.png', kind: 'file', size: 68, displayPath: 'sample.png' }]
          },
          read: async options => { window.__fileCalls.push(['read', options]); return pixel },
          fromDrop: async () => { throw new Error('Unexpected drop path') }
        }
      } })
    }, { pixel })
    let nativeChoosers = 0
    page.on('filechooser', () => nativeChoosers++)
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`/plugins/com.enest.${id}/index.html`)
    if (id === 'qrcode') await page.locator('[data-tab="decode"]').click()
    await page.locator(button).click()
    await expect.poll(() => page.evaluate(() => window.__fileCalls.length)).toBe(1)
    expect(await page.evaluate(() => window.__fileCalls[0][1])).toMatchObject({ kind: 'file', access: 'read' })
    expect(await page.evaluate(() => window.__fileCalls.filter(call => call[0] === 'read'))).toEqual([])
    await page.evaluate(() => { window.__fileMode = 'deny' })
    await page.locator(button).click()
    await expect(page.locator('#plugin-notice')).toContainText('fs.read permission denied')
    await page.evaluate(() => { window.__fileMode = 'allow' })
    await page.locator(button).click()
    await expect.poll(() => page.evaluate(() => window.__fileCalls.filter(call => call[0] === 'read').length)).toBe(1)
    expect(await page.evaluate(() => window.__fileCalls.find(call => call[0] === 'read')[1])).toMatchObject({ handleId: 'allowed-file', encoding: 'dataUrl' })
    if (id === 'hash') await expect(page.locator('#hash-file-result')).toContainText('SHA-256')
    if (id === 'image-tools') {
      await expect(page.locator('.thumb')).toHaveCount(1)
      await page.locator('.thumb').click()
      await page.locator('#run-compress').click()
      await expect(page.locator('#compress-progress')).toContainText('完成')
      for (const action of ['save-result', 'pin-result', 'use-result']) await expect(page.locator(`#${action}`)).toBeEnabled()
    }
    if (id === 'color-picker') await expect(page.locator('#picker-panel')).toBeVisible()
    if (id === 'screen-assistant') await expect(page.locator('#copy-image')).toBeEnabled()
    expect(nativeChoosers).toBe(0)
    expect(errors).toEqual([])
  })
}
for (const id of ['batch-rename', 'lan-share']) {
  test(`${id}: picker uses authorized handles without native file input or unnecessary byte reads`, async ({ page }) => {
    await page.addInitScript(installPreviewFixture, { pluginId: `com.enest.${id}`, mode: 'shell' })
    await page.addInitScript(() => {
      window.__choice = 'cancel'; window.__reads = 0
      const original = window.enest
      window.enest = new Proxy(original, { get(target, key) {
        if (key !== 'localFiles') return target[key]
        return {
          pick: async options => {
            if (options.access !== 'read') throw new Error('Missing access purpose')
            if (window.__choice === 'deny') throw new Error('fs.read permission denied')
            return window.__choice === 'allow' ? [{ id: 'allowed-queue', name: 'project-notes.txt', kind: 'file', size: 1024 }] : []
          },
          read: async () => { window.__reads++; throw new Error('Queue must not read file contents') }
        }
      } })
    })
    let choosers = 0; page.on('filechooser', () => choosers++)
    await page.goto(`/plugins/com.enest.${id}/index.html`)
    await page.locator('#pick-btn').click()
    await expect(page.locator('.f-name')).toHaveCount(0)
    await page.evaluate(() => { window.__choice = 'deny' })
    await page.locator('#pick-btn').click()
    await expect(page.locator('#plugin-notice')).toContainText('fs.read permission denied')
    await page.evaluate(() => { window.__choice = 'allow' })
    await page.locator('#pick-btn').click()
    await expect(page.locator('.f-name')).toHaveText('project-notes.txt')
    expect(await page.evaluate(() => window.__reads)).toBe(0)
    expect(choosers).toBe(0)
  })
}
