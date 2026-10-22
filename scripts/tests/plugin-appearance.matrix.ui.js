import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { installPreviewFixture } from '../preview-fixture.mjs'
import { appearanceCases, snapshotFor } from './appearance-fixture.js'

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64')
const visualSamples = new Set(['remote-desktop', 'markdown', 'todos', 'password-kit', 'screen-assistant'])

// Each row registers a primary path and a mutable business input/selection.
// Remote transports, OS effects, files and services remain isolated fixtures.
const plugins = [
  ['anything', 'collection', '.workspace', '#query', 'release', 'Search the isolated file index'],
  ['batch-rename', 'flow', '.rn-workbench', '#rule-list input[type="text"]', 'theme-', 'Pick fixture files and preview a prefix rule'],
  ['calculator', 'instrument', '.workbench', '#expr', '21*2', 'Enter a calculation draft'],
  ['ccswitch', 'collection', '.app', '#provider-search', 'fixture-provider', 'Filter provider configuration without applying it'],
  ['clipboard', 'collection', '.workspace', '#search', '工作流', 'Filter fixture clipboard history'],
  ['codec', 'editor', '.panes', '#input', 'eNest theme draft', 'Encode text while preserving the source draft'],
  ['codex-pets', 'collection', '.cp-grid', '#g-q', 'cat', 'Filter the isolated pet gallery'],
  ['color-picker', 'flow', '.color-layout', '#color-input', '#246d78', 'Edit the current color'],
  ['cron', 'instrument', '.workbench', '#expression', '*/5 * * * *', 'Preview next scheduled executions'],
  ['database', 'workbench', '.workspace', '.nav-search', 'fixture connection', 'Filter connections; connected engine preservation is tested separately'],
  ['diff', 'editor', '.editor', '#source', 'first\nchanged draft', 'Enter the first comparison document'],
  ['dsh', 'workbench', '.settings', '#profile-name', 'theme-draft', 'Open settings and draft a profile without starting a process'],
  ['hash', 'editor', '.page:visible', '#hash-input', 'eNest theme draft', 'Hash a text draft locally'],
  ['image-tools', 'flow', '.work-layout', '#wm-text', 'eNest draft', 'Load an isolated PNG and draft its watermark'],
  ['json-tools', 'editor', '.editors', '#input', '{"theme":"draft","count":31}', 'Parse a JSON source draft'],
  ['lan-share', 'flow', '.layout', '#device-name', 'Theme fixture', 'Draft a device name without starting a share service'],
  ['markdown', 'editor', '.workspace', '#editor', '# Theme draft\n\nKeep this document.', 'Create and edit a local Markdown note'],
  ['middleware', 'workbench', '.app-body', '#connection-search', 'fixture connection', 'Filter connections; connected engine preservation is tested separately'],
  ['net-kit', 'workbench', '.nk-split', 'input[placeholder^="https://api."]', 'https://example.test/theme-draft', 'Draft an HTTP request without sending network traffic'],
  ['password-kit', 'instrument', '.layout', '#exclude', '0O1l', 'Change local password generation exclusions'],
  ['pomodoro', 'instrument', '.workspace', '#task', 'Theme acceptance', 'Draft the next focus task without starting a timer'],
  ['regex', 'editor', '.workbench', '#pattern', 'theme\\w+', 'Edit a regular expression draft'],
  ['remote-desktop', 'workbench', '.workspace', '#search', 'design', 'Filter remote profiles without connecting'],
  ['screen-assistant', 'flow', '.editor-layout', '#annotation-text', 'Theme draft', 'Import an isolated PNG and draft a text annotation'],
  ['ssh', 'workbench', '.app', '#search-input', 'fixture connection', 'Filter profiles; fitted terminal/session preservation is tested separately'],
  ['sticky-notes', 'collection', '.app', '#title', 'Theme draft note', 'Create a note and preserve its unsaved edit'],
  ['sysguard', 'collection', '.sg', '.sg-search:visible', 'eNest', 'Filter fixture processes without terminating anything'],
  ['timestamp', 'instrument', '.workspace', '#input', '1791856800', 'Convert a timestamp draft'],
  ['todos', 'collection', '.workspace', '#search', '插件', 'Filter fixture task collection'],
  ['translate', 'editor', '.workspace', '#input', 'Keep the translation draft', 'Draft source text without requesting translation'],
  ['unit-convert', 'instrument', '.uc', '#rows input', '42', 'Convert the first length unit locally'],
]

async function prepare(page, plugin) {
  if (plugin === 'batch-rename') {
    await page.locator('#pick-btn').click()
    await page.locator('#rule-add').selectOption('insert', { force: true })
  }
  if (plugin === 'dsh') await page.locator('[data-act="settings"]').click()
  if (plugin === 'image-tools') {
    await page.locator('#file-input').setInputFiles({ name: 'theme-fixture.png', mimeType: 'image/png', buffer: tinyPng })
    await page.getByRole('button', { name: '选择 theme-fixture.png' }).click()
    await expect(page.locator('.work-layout')).toBeVisible()
    await page.locator('[data-tab="watermark"]').click()
  }
  if (plugin === 'password-kit') await page.locator('.advanced summary').click()
  if (plugin === 'screen-assistant') {
    await page.locator('#image-file').setInputFiles({ name: 'theme-fixture.png', mimeType: 'image/png', buffer: tinyPng })
    await page.locator('[data-tool="text"]').click()
  }
  if (plugin === 'markdown') await page.locator('#new-note').click()
  if (plugin === 'sticky-notes') await page.locator('#new').click()
  if (plugin === 'sysguard') await page.locator('[data-tab="proc"]').click()
}

for (const [plugin, family, primarySelector, inputSelector, value, operation] of plugins) {
  test(`${plugin}: default modes and third-party contract preserve geometry, focus and draft`, async ({ page }, testInfo) => {
    test.setTimeout(20000)
    const errors = [], evidence = []
    page.on('pageerror', error => errors.push(error.message))
    const initial = snapshotFor('default', 'light', 1)
    await page.addInitScript({ content: `window.__appearanceSnapshot = ${JSON.stringify(initial)}; (${installPreviewFixture.toString()})(${JSON.stringify({ pluginId: plugin })}); window.__appearance = snapshot => { window.__appearanceSnapshot = snapshot; for (const callback of window.__appearanceListeners || []) callback(snapshot) }; Object.defineProperty(window, 'enest', { value: window.enest, configurable: false, writable: false });` })
    await page.goto(`/plugins/${plugin}/index.html?pid=com.github.eNest.${plugin}`)
    await expect(page.locator('.pk-appearance')).toHaveAttribute('data-layout-family', family)
    await expect(page.locator('.pk-appearance')).toHaveAttribute('data-plugin', plugin)
    await prepare(page, plugin)
    const input = page.locator(inputSelector).first()
    await input.fill(value)
    await page.keyboard.press('Tab')
    await input.focus()
    await expect(input).toHaveAccessibleName(/\S/)
    await input.evaluate(element => { window.__appearanceAnchor = element })
    const stableValue = await input.inputValue()
    const primary = page.locator(primarySelector).first()
    await expect(primary).toBeVisible()
    await primary.evaluate(element => { window.__appearancePrimary = element })
    const cdp = await page.context().newCDPSession(page)
    let revision = 1
    for (const mode of ['light', 'dark']) {
      for (const kind of appearanceCases) await test.step(`${kind}/${mode}`, async () => {
        const snapshot = snapshotFor(kind, mode, ++revision)
        await page.evaluate(snapshot => window.__appearance(snapshot), snapshot)
        await expect(page.locator('html')).toHaveAttribute('data-appearance-theme', snapshot.theme.id)
        await expect(page.locator('html')).toHaveAttribute('data-appearance-layout', snapshot.layout.variant)
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        await expect(page.locator('html')).toHaveCSS('--appearance-gap', `${snapshot.layout.gap}px`)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await expect(input).toBeFocused()
        await expect(input).toHaveValue(stableValue)
        await expect(input).toHaveAccessibleName(/\S/)
        await expect(input).toBeInViewport()
        await expect(page.locator('[data-appearance-region="main"]').first()).toBeAttached()
        const geometry = await primary.evaluate(element => {
          const box = element.getBoundingClientRect()
          const children = [...element.children].map(child => child.getBoundingClientRect()).filter(rect => rect.width && rect.height).map(rect => ({ x: Math.round(rect.x - box.x), y: Math.round(rect.y - box.y), width: Math.round(rect.width), height: Math.round(rect.height) }))
          const root = document.documentElement, style = getComputedStyle(element)
          const regions = Object.fromEntries(['navigation', 'toolbar', 'main', 'auxiliary', 'status'].map(region => [region, document.querySelectorAll(`[data-appearance-region="${region}"]`).length]))
          return { box: { x: box.x, y: box.y, width: box.width, height: box.height }, children, gap: style.gap, padding: style.padding, rowTracks: style.gridTemplateRows, columnTracks: style.gridTemplateColumns, documentWidth: root.scrollWidth, viewportWidth: innerWidth, sameInput: window.__appearanceAnchor === document.activeElement, samePrimary: window.__appearancePrimary === element, regions }
        })
        expect(geometry.sameInput).toBe(true)
        expect(geometry.samePrimary).toBe(true)
        expect(geometry.box.width).toBeGreaterThan(100)
        expect(geometry.box.height).toBeGreaterThan(20)
        expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1)
        if (plugin === 'markdown') {
          const note = page.locator('.note-row').first(), heading = note.locator('.note-title > span').first()
          await expect(heading).toHaveCSS('white-space', 'nowrap')
          const titleBox = await heading.boundingBox(), dateBox = await note.locator('.note-meta').boundingBox()
          expect(titleBox.width).toBeGreaterThan(60)
          expect(titleBox.right ?? titleBox.x + titleBox.width).toBeLessThan(dateBox.x)
        }
        const { nodes } = await cdp.send('Accessibility.getFullAXTree')
        const controls = nodes.filter(node => !node.ignored && ['button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'slider', 'spinbutton', 'tab', 'link'].includes(node.role?.value))
        const unnamed = controls.filter(node => !node.name?.value?.trim()).map(node => ({ role: node.role?.value, backendNodeId: node.backendDOMNodeId }))
        expect(unnamed, `${plugin} ${kind}/${mode} unnamed interactive controls`).toEqual([])
        expect(controls.length).toBeGreaterThan(0)
        evidence.push({ plugin, family, case: kind, theme: snapshot.theme, layout: snapshot.layout.variant, mode, operation, draft: stableValue, geometry, namedControls: controls.length, externalServices: 'isolated fixtures only' })
        if (process.env.APPEARANCE_SCREENSHOT_DIR && visualSamples.has(plugin) && mode === 'light') {
          await mkdir(process.env.APPEARANCE_SCREENSHOT_DIR, { recursive: true })
          await page.screenshot({ path: join(process.env.APPEARANCE_SCREENSHOT_DIR, `${plugin}-${kind}.png`) })
        }
      })
      await testInfo.attach(`appearance-${mode}.json`, { body: JSON.stringify(evidence.filter(row => row.mode === mode), null, 2), contentType: 'application/json' })
    }
    await cdp.detach()
    expect(errors).toEqual([])
    expect(evidence).toHaveLength(appearanceCases.length * 2)
    await testInfo.attach('appearance-matrix.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  })
}
