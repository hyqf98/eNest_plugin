import { test, expect } from '@playwright/test'
import { fixture as databaseFixture, connect as connectDatabase, setQuery } from '../../plugins/database/tests/database-fixture.js'
import { sshFixture, connectSsh, setCommand, fitSshTerminal } from '../../plugins/ssh/tests/ssh-fixture.js'
import { fixture as middlewareFixture, openConnection, openPage } from '../../plugins/middleware/tests/middleware-fixture.js'
import { applyWorkbenchTheme } from './workbench-theme.js'

const preferences = [
  { name: 'standard', motion: 'no-preference', transparency: 'no-preference', contrast: 'no-preference', forced: 'none' },
  { name: 'reduced-motion', motion: 'reduce', transparency: 'no-preference', contrast: 'no-preference', forced: 'none' },
  { name: 'solid-surfaces', motion: 'no-preference', transparency: 'reduce', contrast: 'no-preference', forced: 'none' },
  { name: 'high-contrast', motion: 'no-preference', transparency: 'no-preference', contrast: 'more', forced: 'none' },
  { name: 'forced-colors', motion: 'reduce', transparency: 'reduce', contrast: 'more', forced: 'active' },
]
const viewports = [
  { width: 720, height: 560, mode: 'shell' },
  { width: 1024, height: 720, mode: 'shell' },
  { width: 1440, height: 900, mode: 'shell' },
  { width: 480, height: 240, mode: 'quick' },
  { width: 720, height: 420, mode: 'quick' },
]

const plugins = {
  database: {
    async setup(page) { await databaseFixture(page); await connectDatabase(page) },
    toggle: '#side-toggle', navigation: '.app #side', font: '.nav-search',
    popup: '.monaco-editor .suggest-widget.visible, .completion-popup:not([hidden])',
    async mode(page, value) {
      const previous = await page.locator('.app').getAttribute('data-surface')
      await page.evaluate(value => window.__mode(value), value)
      await expect(page.locator('.app')).toHaveAttribute('data-surface', value)
      if (value === 'quick' && previous !== 'quick') await connectDatabase(page)
    },
    async suggest(page) { await setQuery(page, 'SELECT na FROM customers'); await page.keyboard.press('Home'); for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight'); await page.keyboard.press('Control+Space') },
  },
  ssh: {
    async setup(page) { await sshFixture(page); await connectSsh(page) },
    toggle: '[data-navigation=connections]', navigation: '#side-body', font: '#search-input', popup: '.ssh-command-suggestions',
    async mode(page, value) { await page.evaluate(value => window.__mode(value), value); await expect(page.locator('html')).toHaveAttribute('data-launch-mode', value) },
    async suggest(page) {
      // Emit one trusted prompt after actual cell measurement and fit, including compact Quick panes.
      await fitSshTerminal(page)
      await setCommand(page, 'docker ')
      await page.evaluate(() => window.SshWorkbenchBridge.runCompletion(true))
    },
  },
  middleware: {
    async setup(page) { await middlewareFixture(page); await openConnection(page); await openPage(page, 'messages') },
    toggle: '#nav-toggle', navigation: '#tree', font: '#connection-search', popup: '.mw-suggestions:visible',
    async mode(page, value) { await page.evaluate(value => window.__modeChange(value), value); await expect(page.locator('body')).toHaveAttribute('data-mode', value) },
    async suggest(page) { const target = page.locator('[data-page-panel=messages]:visible').getByLabel('消息查询目标'); await target.fill('order'); await target.press('Control+Space') },
  },
}

for (const [name, plugin] of Object.entries(plugins)) for (const preference of preferences) {
  test(`${name}: ${preference.name} across desktop/Quick, light/dark and host font scale`, async ({ page }) => {
    test.setTimeout(120000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-motion', value: preference.motion },
      { name: 'prefers-reduced-transparency', value: preference.transparency },
      { name: 'prefers-contrast', value: preference.contrast },
      { name: 'forced-colors', value: preference.forced },
    ] })
    await plugin.setup(page)
    await page.evaluate(() => document.documentElement.style.setProperty('--font-size-base', '13px'))
    const baseFont = await page.locator(plugin.font).evaluate(element => parseFloat(getComputedStyle(element).fontSize))
    let index = 0
    for (const viewport of viewports) for (const theme of ['light', 'dark']) {
      await test.step(`${viewport.mode} ${viewport.width}×${viewport.height} ${theme}`, async () => {
        await page.setViewportSize(viewport)
        await plugin.mode(page, viewport.mode)
        await applyWorkbenchTheme(page, theme)
        const scale = theme === 'dark' ? 1.3 : 1
        await page.evaluate(({ scale, animation }) => {
          document.documentElement.style.setProperty('--font-size-base', `${13 * scale}px`)
          document.documentElement.dataset.anim = animation
        }, { scale, animation: ['low', 'medium', 'high'][index++ % 3] })
        // The shared reduced-motion rule retains a .01ms transition. A computed read in
        // the same frame can still report the previous font; assert the settled size.
        if (scale > 1) await expect.poll(() => page.locator(plugin.font).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(baseFont * 1.2)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
        await plugin.suggest(page)
        const popup = page.locator(plugin.popup).first()
        await expect(popup).toBeVisible()
        if (name === 'database') {
          await expect(popup.locator('.monaco-list-row, .comp-item').first()).toBeVisible()
          if (preference.forced === 'active') {
            const selected = popup.locator('.monaco-list-row.focused, .comp-item.active').first()
            await expect(selected).toBeVisible()
            await expect(selected.locator('.monaco-highlighted-label, .comp-label').first()).toHaveText(/\S/)
            await expect(selected).toHaveCSS('forced-color-adjust', 'none')
            // Geometry alone missed white text backplates. Check every visible text
            // fragment, including the matched prefix and the right-hand description.
            const textStyles = await selected.evaluate(row => {
              const rgba = value => value.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0]
              const luminance = channels => channels.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
              return [...row.querySelectorAll('*')].filter(element => {
                const box = element.getBoundingClientRect()
                return box.width > 0 && box.height > 0 && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
              }).map(element => {
                const style = getComputedStyle(element)
                let background = [0, 0, 0, 0]
                for (let parent = element; parent && (background[3] ?? 1) === 0; parent = parent.parentElement) background = rgba(getComputedStyle(parent).backgroundColor)
                const foreground = luminance(rgba(style.color)), backdrop = luminance(background)
                return { text: element.textContent.trim(), adjustment: style.forcedColorAdjust, ratio: (Math.max(foreground, backdrop) + .05) / (Math.min(foreground, backdrop) + .05) }
              })
            })
            expect(textStyles.length).toBeGreaterThan(0)
            for (const fragment of textStyles) {
              expect(fragment.adjustment, fragment.text).toBe('none')
              expect(fragment.ratio, fragment.text).toBeGreaterThanOrEqual(4.5)
            }
          }
        }
        const box = await popup.boundingBox()
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
        if (preference.forced === 'active') await expect(popup).toHaveCSS('forced-color-adjust', 'auto')
        if (viewport.width === 720 && viewport.mode === 'quick' && theme === 'dark') await page.screenshot({ path: `test-results-workbenches/phase2-${name}-${preference.name}.png` })
        await page.keyboard.press('Escape')
        await expect(popup).not.toBeVisible()
        const toggle = page.locator(plugin.toggle)
        if (viewport.mode === 'quick') {
          if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click()
          await toggle.focus(); await toggle.press('Enter')
          await expect(toggle).toHaveAttribute('aria-expanded', 'true')
          await expect(page.locator(plugin.navigation)).toBeInViewport()
          await page.keyboard.press('Escape')
          await expect(toggle).toHaveAttribute('aria-expanded', 'false')
          await expect(toggle).toBeFocused()
        }
        await toggle.focus()
        const focus = await toggle.evaluate(element => ({ visible: element.matches(':focus-visible'), outline: getComputedStyle(element).outlineStyle, width: parseFloat(getComputedStyle(element).outlineWidth) }))
        expect(focus.visible).toBe(true)
        expect(focus.outline).not.toBe('none')
        expect(focus.width).toBeGreaterThan(0)
      })
    }
    expect(errors).toEqual([])
    await cdp.detach()
  })
}
