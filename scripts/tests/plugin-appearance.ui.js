import { test, expect } from '@playwright/test'
import { fixture as databaseFixture, connect, setQuery, runQuery } from '../../plugins/database/tests/database-fixture.js'
import { fixture as middlewareFixture, openConnection, openPage } from '../../plugins/middleware/tests/middleware-fixture.js'
import { sshFixture, connectSsh, fitSshTerminal, setCommand } from '../../plugins/ssh/tests/ssh-fixture.js'
import { installPreviewFixture } from '../preview-fixture.mjs'
import { appearanceCases, snapshotFor as actualAppearance } from './appearance-fixture.js'

async function eachActualAppearance(page, verify) {
  let revision = 100
  for (const mode of ['light', 'dark']) for (const kind of appearanceCases) await test.step(`${kind}/${mode}`, async () => {
    const snapshot = actualAppearance(kind, mode, ++revision)
    await page.evaluate(snapshot => window.__appearance(snapshot), snapshot)
    await expect(page.locator('html')).toHaveAttribute('data-appearance-theme', snapshot.theme.id)
    await expect(page.locator('html')).toHaveAttribute('data-appearance-layout', snapshot.layout.variant)
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await verify(snapshot)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

const appearance = actualAppearance('contract', 'light', 7)

function nextAppearance(patch = {}, revision = appearance.revision + 1) {
  return structuredClone({ ...appearance, ...patch, revision })
}

async function installAppearance(page) {
  await page.addInitScript(({ snapshot }) => {
    let current = snapshot
    window.__appearance = value => { current = value; for (const callback of window.__appearanceListeners || []) callback(value) }
    // Plugin fixtures replace window.enest as a whole; merge the bridge in at load time.
    let hostApi
    Object.defineProperty(window, 'enest', {
      configurable: true,
      get() { return hostApi },
      set(value) {
        const incoming = value && typeof value === 'object' ? value : {}
        const merged = incoming === hostApi ? incoming : { ...hostApi, ...incoming }
        merged.theme = { ...merged.theme, getAppearance: async () => structuredClone(current), onAppearanceChange: callback => {
          window.__appearanceListeners ||= new Set()
          window.__appearanceListeners.add(callback)
          return () => window.__appearanceListeners.delete(callback)
        } }
        hostApi = merged
      }
    })
    window.enest = {}
  }, { snapshot: appearance })
}

test('appearance adapter applies full snapshots, removes stale tokens, and ignores stale revisions', async ({ page }) => {
  await installAppearance(page)
  await page.goto('/plugins/remote-desktop/index.html')
  const root = page.locator('#root')
  await expect(root).toHaveAttribute('data-layout-family', 'workbench')
  await expect(root).toHaveAttribute('data-plugin', 'remote-desktop')
  await expect(page.locator('html')).toHaveAttribute('data-appearance-theme', 'contract-theme')
  await expect(page.locator('html')).toHaveAttribute('data-appearance-layout', 'studio-board')
  await expect(page.locator('html')).toHaveAttribute('data-anim', 'low')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-heading').trim())).toBe(appearance.fonts.heading)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--appearance-control-radius').trim())).toBe('4px')
  await expect(page.locator('.side')).toHaveCSS('width', '264px')
  await expect(page.locator('.workspace')).toHaveCSS('gap', '8px')

  await page.evaluate(snapshot => window.__appearance(snapshot), nextAppearance({
    mode: 'dark',
    theme: { ...actualAppearance('default', 'dark', 8).theme },
    tokens: { '--surface': '#F7F3ED' },
    fonts: { ...appearance.fonts, heading: 'Kaiti SC, serif' },
    components: { ...appearance.components, controlRadius: 10 },
    layout: { ...appearance.layout, variant: 'default', gap: 16, sidebarWidth: 240 }
  }, 8))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-appearance-theme', 'default')
  await expect(page.locator('html')).toHaveAttribute('data-appearance-layout', 'default')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-heading').trim())).toBe('Kaiti SC, serif')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--appearance-control-radius').trim())).toBe('10px')
  await expect(page.locator('html')).toHaveCSS('--accent', '#3579dd')
  await expect(page.locator('.workspace')).toHaveCSS('gap', '16px')

  await page.evaluate(snapshot => window.__appearance(snapshot), nextAppearance({
    theme: { ...appearance.theme, id: 'stale-contract' },
    layout: { ...appearance.layout, variant: 'stale-layout' }
  }, 6))
  await expect(page.locator('html')).toHaveAttribute('data-appearance-theme', 'default')
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--surface'))).toBe('#F7F3ED')
})

test('database contract geometry keeps persisted side width and editor fit', async ({ page }) => {
  await installAppearance(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await databaseFixture(page); await connect(page)
  await expect(page.locator('#root')).toHaveAttribute('data-plugin', 'database')
  await expect(page.locator('.side')).toHaveCSS('width', '240px')
  const editor = page.locator('.monaco-editor').first()
  const side = page.locator('.side'), status = page.locator('.wb-status')
  await expect(editor).toBeVisible()
  const before = await editor.boundingBox(), sideBefore = await side.boundingBox()
  await expect(status).toBeInViewport({ ratio: 1 })
  expect(sideBefore.width).toBe(240)
  expect(before.height).toBeGreaterThan(240)
  await page.setViewportSize({ width: 960, height: 620 })
  await expect(status).toBeInViewport({ ratio: 1 })
  const after = await page.locator('.monaco-editor').first().boundingBox()
  expect(Math.abs(after.width - (before.width - 320))).toBeLessThan(12)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('middleware contract geometry keeps keyboard resize bounds and contained grids', async ({ page }) => {
  await installAppearance(page)
  await page.setViewportSize({ width: 1024, height: 720 })
  await middlewareFixture(page); await openConnection(page)
  await expect(page.locator('#root')).toHaveAttribute('data-plugin', 'middleware')
  const tree = page.locator('#tree')
  await expect(tree).toHaveCSS('width', '240px')
  const separator = page.locator('#resizer-tree')
  await separator.focus(); await separator.press('End')
  await expect(separator).toHaveAttribute('aria-valuenow', '360')
  await expect(tree).toHaveCSS('width', '360px')
  await separator.press('Home')
  await expect(separator).toHaveAttribute('aria-valuenow', '220')
  await expect(tree).toHaveCSS('width', '220px')
  await page.setViewportSize({ width: 480, height: 360 })
  await expect(page.locator('#app')).toHaveClass(/navigation-compact/)
  await expect(page.locator('html')).toHaveAttribute('data-appearance-layout', 'studio-board')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('SSH contract geometry preserves a live fitted terminal while appearance changes', async ({ page }) => {
  await installAppearance(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await sshFixture(page)
  const sessionId = await connectSsh(page)
  await fitSshTerminal(page)
  await expect(page.locator('#root')).toHaveAttribute('data-plugin', 'ssh')
  const terminal = page.locator('#panel-term')
  const before = await terminal.boundingBox()
  expect(before.width).toBeGreaterThan(700)
  expect(before.height).toBeGreaterThan(450)
  await page.evaluate(snapshot => window.__appearance(snapshot), nextAppearance({
    theme: { ...actualAppearance('default', 'light', 8).theme },
    layout: { ...appearance.layout, variant: 'default', sidebarWidth: 280, gap: 14 }
  }, 8))
  await expect(page.locator('html')).toHaveAttribute('data-appearance-layout', 'default')
  await fitSshTerminal(page)
  const after = await terminal.boundingBox()
  expect(after.height).toBeGreaterThan(350)
  expect(await page.evaluate(() => window.SshWorkbenchBridge.activeSession().sessionId)).toBe(sessionId)
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'disconnect'))).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('frozen bridge subscribes before a delayed read and releases appearance listeners on destroy', async ({ page }) => {
  const initial = actualAppearance('contract', 'light', 10), latest = actualAppearance('default', 'dark', 11)
  await page.addInitScript({ content: `window.__appearanceSnapshot = ${JSON.stringify(initial)}; (${installPreviewFixture.toString()})({ pluginId: 'remote-desktop' });
    window.__destroyCallbacks = []; window.__appearanceOrder = []; window.__unsubscribeCount = 0;
    const fixtureBridge = window.enest;
    window.enest = new Proxy({
      onDestroy: callback => { window.__destroyCallbacks.push(callback); return () => {} },
      theme: {
        getAppearance: () => { window.__appearanceOrder.push('read'); return new Promise(resolve => { window.__finishAppearanceRead = () => resolve(${JSON.stringify(initial)}) }) },
        onAppearanceChange: callback => { window.__appearanceOrder.push('subscribe'); callback(${JSON.stringify(latest)}); return () => window.__unsubscribeCount++ },
        getTokens: async () => ({ mode: 'dark', tokens: ${JSON.stringify(latest.tokens)} })
      }
    }, { get(target, key) { return Object.hasOwn(target, key) ? target[key] : fixtureBridge[key] } });
    Object.defineProperty(window, 'enest', { value: window.enest, writable: false, configurable: false });` })
  await page.goto('/plugins/remote-desktop/index.html?pid=com.github.eNest.remote-desktop')
  await expect(page.locator('html')).toHaveAttribute('data-appearance-theme', 'default')
  expect(await page.evaluate(() => window.__appearanceOrder)).toEqual(['subscribe', 'read'])
  await page.evaluate(() => window.__finishAppearanceRead())
  await expect(page.locator('html')).toHaveAttribute('data-appearance-theme', 'default')
  await page.evaluate(() => window.__destroyCallbacks.forEach(callback => callback()))
  expect(await page.evaluate(() => window.__unsubscribeCount)).toBe(1)
})

test('adapter retains valid host boundary values and honors continuous-motion limits', async ({ page }) => {
  await installAppearance(page)
  await page.goto('/plugins/remote-desktop/index.html')
  const wide = nextAppearance({
    layout: { ...appearance.layout, density: .8, gap: 0, sidebarWidth: 440, contentWidth: 640, columns: 6 },
    components: { ...appearance.components, panelRadius: 40, borderWidth: 6 },
    animation: { requested: 'high', effective: 'high', continuous: true },
    background: { ...appearance.background, effect: 'aurora', speed: .25 }
  }, 9)
  await page.evaluate(snapshot => window.__appearance(snapshot), wide)
  for (const [key, value] of Object.entries({ density: '.8', gap: '0px', 'sidebar-width': '440px', 'content-width': '640px', columns: '6', 'panel-radius': '40px', 'border-width': '6px', 'bg-speed': '.25' })) {
    await expect.poll(() => page.evaluate(key => getComputedStyle(document.documentElement).getPropertyValue(`--appearance-${key}`).trim(), key)).toBe(value.replace(/^\./, '0.'))
  }
  expect(await page.locator('#root').evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('pk-appearance-drift')
  await page.evaluate(snapshot => window.__appearance(snapshot), { ...wide, revision: 10, animation: { ...wide.animation, effective: 'low', continuous: false } })
  expect(await page.locator('#root').evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none')
})

test('database retains its Monaco model across default modes and third-party contract snapshots', async ({ page }) => {
  await installAppearance(page)
  await databaseFixture(page); await connect(page)
  const sql = 'SELECT 42 AS theme_draft;\n-- keep this unsaved draft'
  await setQuery(page, sql)
  await page.evaluate(async () => {
    const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name)
    const editor = monaco.editor.getEditors()[0]
    editor.setSelection(new monaco.Selection(1, 8, 1, 10)); editor.focus()
    window.__appearanceEngine = { editor, model: editor.getModel(), selection: editor.getSelection(), sessions: Object.keys(window.__sessions) }
  })
  await eachActualAppearance(page, async snapshot => {
    const state = await page.evaluate(() => {
      const { editor, model, selection, sessions } = window.__appearanceEngine
      return { sameModel: editor.getModel() === model, disposed: model.isDisposed(), value: editor.getValue(), selection: editor.getSelection().equalsSelection(selection), focused: editor.hasTextFocus(), width: editor.getLayoutInfo().width, hostWidth: editor.getDomNode().clientWidth, fontFamily: editor.getRawOptions().fontFamily, fontSize: editor.getRawOptions().fontSize, sessionsRetained: sessions.every(key => Object.hasOwn(window.__sessions, key)), closeCalls: window.__calls.filter(([kind]) => kind === 'close') }
    })
    expect(state.sameModel).toBe(true); expect(state.disposed).toBe(false)
    expect(state.value).toBe(sql); expect(state.selection).toBe(true); expect(state.focused).toBe(true)
    expect(Math.abs(state.width - state.hostWidth)).toBeLessThanOrEqual(1)
    expect(state.fontFamily.trim()).toBe(snapshot.fonts.mono)
    expect(state.fontSize).toBeCloseTo(13 * snapshot.fonts.scale, 3)
    expect(state.sessionsRetained).toBe(true); expect(state.closeCalls).toEqual([])
  })
  await page.evaluate(() => window.__appearanceEngine.editor.setPosition({ lineNumber: 1, column: 1 }))
  await runQuery(page)
  await expect.poll(() => page.evaluate(() => window.__calls.filter(([kind]) => kind === 'execute').length)).toBe(1)
  await expect(page.locator('#results')).toContainText('阿尔法')
})

test('middleware retains results, draft, caret and tree size across default modes and third-party snapshots', async ({ page }) => {
  await installAppearance(page)
  await middlewareFixture(page); await openConnection(page)
  const messages = await openPage(page, 'messages')
  await messages.getByLabel('消息查询目标').fill('order-events')
  await messages.getByLabel('消息查询目标').press('Escape')
  await messages.getByRole('button', { name: '查询', exact: true }).click()
  await expect(messages.locator('tbody')).toContainText('23942')
  const publish = await openPage(page, 'publish'), input = publish.getByLabel('消息内容')
  await publish.getByLabel('发布目标').fill('order-events')
  await input.fill('{"theme":"unsent draft"}'); await input.press('Escape')
  await page.locator('#resizer-tree').focus(); await page.locator('#resizer-tree').press('End')
  await input.focus()
  await input.evaluate(element => { element.setSelectionRange(2, 7); window.__appearanceInput = element })
  const sessions = await page.evaluate(() => Object.keys(window.__mwSessions))
  await eachActualAppearance(page, async () => {
    await expect(input).toHaveValue('{"theme":"unsent draft"}'); await expect(input).toBeFocused()
    expect(await input.evaluate(element => ({ same: element === window.__appearanceInput, start: element.selectionStart, end: element.selectionEnd }))).toEqual({ same: true, start: 2, end: 7 })
    await expect(page.locator('#tree')).toHaveCSS('width', '360px')
    expect(await page.evaluate(() => Object.keys(window.__mwSessions))).toEqual(sessions)
    expect(await page.evaluate(() => window.__mwCalls.filter(call => ['session.close', 'messages.send'].includes(call.action)))).toEqual([])
  })
  await page.locator('[data-task="orders:messages"]').click()
  await expect(messages.locator('tbody')).toContainText('23942')
  expect(await page.evaluate(() => window.__mwCalls.filter(call => call.action === 'session.open').length)).toBe(1)
})

test('SSH retains xterm, remote draft, selection and session across default modes and third-party snapshots', async ({ page }) => {
  await installAppearance(page)
  await sshFixture(page); const sessionId = await connectSsh(page)
  const command = 'echo theme-draft'
  await setCommand(page, command)
  await page.evaluate(length => {
    const session = window.SshWorkbenchBridge.activeSession(), term = session.term.raw, buffer = term.buffer.active
    term.select(9, buffer.baseY + buffer.cursorY, length)
    window.__appearanceTerminal = { session, term, element: term.element }
  }, command.length)
  await eachActualAppearance(page, async snapshot => {
    await fitSshTerminal(page)
    const state = await page.evaluate(() => {
      const session = window.SshWorkbenchBridge.activeSession(), previous = window.__appearanceTerminal
      const buffer = session.term.raw.buffer.active
      return { sessionId: session.sessionId, sameSession: session === previous.session, sameTerm: session.term.raw === previous.term, sameElement: session.term.raw.element === previous.element, selected: session.term.getSelection(), buffer: Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) || '').join('\n'), focused: document.activeElement === session.term.raw.textarea, fontFamily: session.term.raw.options.fontFamily, fontSize: session.term.raw.options.fontSize, background: session.term.raw.options.theme.background, disconnected: window.__calls.filter(([kind]) => kind === 'disconnect') }
    })
    expect(state.sessionId).toBe(sessionId); expect(state.sameSession).toBe(true); expect(state.sameTerm).toBe(true); expect(state.sameElement).toBe(true)
    // A column resize intentionally retires parsed prompt trust; never revive it
    // from visible text. The actual remote draft/buffer must remain untouched.
    expect(state.buffer).toContain(`fixture$ ${command}`); expect(state.selected).toBe(command); expect(state.focused).toBe(true)
    expect(state.fontFamily).toBe(snapshot.fonts.mono); expect(state.fontSize).toBeCloseTo(13 * snapshot.fonts.scale, 3)
    expect(state.background).toBe(snapshot.tokens['--surface']); expect(state.disconnected).toEqual([])
  })
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'connect').length)).toBe(1)
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'executed'))).toEqual([])
})
