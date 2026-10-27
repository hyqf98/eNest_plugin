import { test, expect } from '@playwright/test'
import { sshFixture as baseSshFixture, connectSsh, setCommand } from './ssh-fixture.js'
import { applyWorkbenchTheme } from '../../../scripts/tests/workbench-theme.js'

// This suite verifies local semantics; dynamic source integration has its own remote suite.
async function sshFixture(page, mode) {
  await baseSshFixture(page, mode)
  await page.evaluate(() => {
    window.SshWorkbenchBridge.store.setUi({ completion: { remotePaths: false, remoteCommands: false } })
    window.dispatchEvent(new Event('ssh-completion-settings-change'))
  })
}

const popup = page => page.locator('.ssh-command-suggestions')
const names = page => page.locator('.ssh-command-name')
const command = page => page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.readCommand()?.text)
const show = page => page.evaluate(() => window.SshWorkbenchBridge.runCompletion(true))
const writes = page => page.evaluate(() => window.__calls.filter(([type]) => type === 'write').map(([, value]) => value))
const clearCalls = page => page.evaluate(() => { window.__calls.length = 0 })

test('SSH suggestions follow echoed input and accepting a command only appends its missing suffix', async ({ page }) => {
  await sshFixture(page); await connectSsh(page); await setCommand(page, '')
  await page.keyboard.type('doc')
  await expect(names(page).filter({ hasText: /^docker$/ })).toBeVisible()
  await names(page).filter({ hasText: /^docker$/ }).hover()
  await expect(popup(page).locator('[data-tip]')).toHaveCount(0)
  await clearCalls(page)
  await names(page).filter({ hasText: /^docker$/ }).click()
  await expect.poll(() => command(page)).toBe('docker')
  expect((await writes(page)).map(write => write.data)).toEqual(['ker'])
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => ['executed', 'exec', 'completion.suggest'].includes(kind)))).toEqual([])
  await expect(page.locator('dialog[open]')).toHaveCount(0)
})

test('SSH contextual subcommands, option values and keyboard acceptance use the same caret list', async ({ page }) => {
  await sshFixture(page); await connectSsh(page)
  await setCommand(page, 'docker compose u'); await show(page)
  await expect(names(page)).toHaveText(['up'])
  await clearCalls(page); await page.keyboard.press('Alt+Enter')
  await expect.poll(() => command(page)).toBe('docker compose up')
  expect((await writes(page)).map(write => write.data)).toEqual(['p'])
  await setCommand(page, 'curl -X P'); await show(page)
  await expect(names(page)).toHaveText(['POST', 'PUT', 'PATCH'])
  await clearCalls(page); await page.keyboard.press('Alt+ArrowDown'); await page.keyboard.press('Alt+Enter')
  await expect.poll(() => command(page)).toBe('curl -X PUT')
  expect((await writes(page)).map(write => write.data)).toEqual(['UT'])
})

test('explicit completion reveals an offscreen prompt while automatic completion preserves scrollback', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 240 }); await sshFixture(page, 'quick'); await connectSsh(page)
  await page.evaluate(() => {
    const session = window.SshWorkbenchBridge.activeSession()
    window.__sshData(session.sessionId, '\x1b]133;C\x07\r\n' + Array.from({ length: 30 }, (_, index) => `output ${index}`).join('\r\n'))
  })
  await setCommand(page, 'docker ')
  await page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.raw.scrollToTop())
  const scrolled = await page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.raw.buffer.active.viewportY)
  await page.evaluate(() => window.SshWorkbenchBridge.runCompletion(false))
  await expect(popup(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.raw.buffer.active.viewportY)).toBe(scrolled)
  await clearCalls(page); await show(page)
  await expect(popup(page)).toBeVisible()
  expect(await page.evaluate(() => { const buffer = window.SshWorkbenchBridge.activeSession().term.raw.buffer.active; return buffer.viewportY === buffer.baseY })).toBe(true)
  await names(page).filter({ hasText: /^ps$/ }).click()
  await expect.poll(() => command(page)).toBe('docker ps')
  expect((await writes(page)).map(write => write.data)).toEqual(['ps'])
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'executed'))).toEqual([])
})

test('Tab, Enter, Up, Down and Ctrl+C retain native terminal semantics while suggestions are visible', async ({ page }) => {
  await sshFixture(page); await connectSsh(page)
  for (const [key, expected] of [['Tab', '\t'], ['ArrowUp', '\x1b[A'], ['ArrowDown', '\x1b[B'], ['Control+c', '\x03'], ['Enter', '\r']]) {
    await setCommand(page, 'doc'); await show(page); await expect(popup(page)).toBeVisible(); await clearCalls(page)
    await page.keyboard.press(key)
    await expect.poll(async () => (await writes(page)).map(write => write.data)).toEqual([expected])
    await expect(popup(page)).toHaveCount(0)
    if (key === 'Enter') expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'executed').map(([, value]) => value.command))).toEqual(['doc'])
  }
})

test('Escape, caret movement and a late remote echo cannot accept or reopen stale suggestions', async ({ page }) => {
  await sshFixture(page); await connectSsh(page); await setCommand(page, 'doc'); await show(page)
  await page.keyboard.press('Escape'); await expect(popup(page)).toHaveCount(0)
  await page.evaluate(() => window.__sshData(window.SshWorkbenchBridge.activeSession().sessionId, ''))
  await expect(popup(page)).toHaveCount(0)
  await setCommand(page, 'doc'); await show(page); await page.keyboard.press('ArrowLeft')
  await expect(popup(page)).toHaveCount(0); await show(page); await expect(popup(page)).toHaveCount(0)
  await setCommand(page, 'doc'); await page.evaluate(() => { window.__sshEcho = false })
  await page.keyboard.type('k'); await expect(popup(page)).toHaveCount(0); await show(page)
  await expect(popup(page)).toHaveCount(0)
  await expect.poll(() => command(page)).toBe(undefined)
})

test('session switches retire completion ownership and do not copy one server command into another', async ({ page }) => {
  await sshFixture(page); const first = await connectSsh(page); await setCommand(page, 'doc'); await show(page)
  const second = await connectSsh(page, 'ops'); await expect(popup(page)).toHaveCount(0)
  await clearCalls(page)
  await page.evaluate(id => window.__sshData(id, '\x1b]133;C\x07'), first)
  await expect(popup(page)).toHaveCount(0)
  await setCommand(page, 'git sta'); await show(page); await names(page).filter({ hasText: /^status$/ }).click()
  await expect.poll(() => command(page)).toBe('git status')
  expect((await writes(page)).map(write => [write.sessionId, write.data])).toEqual([[second, 'tus']])
})

test('a stale list consumes explicit accept during a same-tick session switch; without a list Alt+Enter stays native', async ({ page }) => {
  await sshFixture(page); await connectSsh(page); await connectSsh(page, 'ops')
  await setCommand(page, 'doc'); await show(page); await expect(popup(page)).toBeVisible(); await clearCalls(page)
  await page.evaluate(() => {
    const bridge = window.SshWorkbenchBridge
    const target = [...bridge.sessions.values()].find(session => session !== bridge.activeSession())
    bridge.setActiveTab(target.tabId)
    target.term.raw.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', altKey: true, bubbles: true, cancelable: true }))
  })
  await expect(popup(page)).toHaveCount(0)
  expect(await writes(page)).toEqual([])
  await setCommand(page, 'echo ready'); await clearCalls(page); await page.keyboard.press('Alt+Enter')
  await expect.poll(async () => (await writes(page)).some(write => write.data.includes('\r'))).toBe(true)
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'executed').map(([, value]) => value.command))).toEqual(['echo ready'])
})

test('password, alternate screen, IME and pasted text do not receive guessed local command insertion', async ({ page }) => {
  await sshFixture(page); await connectSsh(page)
  await page.evaluate(() => { const s = window.SshWorkbenchBridge.activeSession(); window.__sshData(s.sessionId, '\x1b]133;C\x07\r\nPassword: ') })
  await show(page); await expect(popup(page)).toHaveCount(0)
  await clearCalls(page)
  expect(await page.evaluate(() => window.SshWorkbenchBridge.fillHint('docker ps'))).toBe(false)
  expect(await writes(page)).toEqual([])
  await setCommand(page, 'doc'); await show(page)
  await page.evaluate(() => { const s = window.SshWorkbenchBridge.activeSession(); window.__sshData(s.sessionId, '\x1b[?1049h') })
  await show(page); await expect(popup(page)).toHaveCount(0)
  await page.evaluate(() => { const s = window.SshWorkbenchBridge.activeSession(); window.__sshData(s.sessionId, '\x1b[?1049l') })
  await setCommand(page, 'doc'); await show(page)
  await page.locator('.active-terminal textarea').dispatchEvent('compositionstart', { data: '中' })
  await expect(popup(page)).toHaveCount(0)
  await show(page); await expect(popup(page)).toHaveCount(0)
  await page.locator('.active-terminal textarea').dispatchEvent('compositionend', { data: '中' })
  await setCommand(page, ''); await page.keyboard.insertText('docker logs ')
  await expect(popup(page)).toHaveCount(0)
})

test('saved local preferences apply to the real terminal without remote completion or execution', async ({ page }) => {
  await sshFixture(page); await connectSsh(page)
  await page.evaluate(() => {
    window.SshWorkbenchBridge.store.setUi({ completion: { commands: false, options: false, snippets: false, history: false, autoSuggest: false, remotePaths: false, remoteCommands: false, userCommands: [{ command: 'deploy status --verbose', description: '查看部署详情' }] } })
    window.dispatchEvent(new Event('ssh-completion-settings-change'))
  })
  await setCommand(page, 'dep'); await clearCalls(page); await show(page)
  await expect(names(page)).toHaveText(['deploy status --verbose'])
  await expect(popup(page)).toContainText('查看部署详情')
  await page.keyboard.press('Alt+Enter'); await expect.poll(() => command(page)).toBe('deploy status --verbose')
  expect((await writes(page)).map(write => write.data)).toEqual(['loy status --verbose'])
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => ['executed', 'completion.suggest', 'exec'].includes(kind)))).toEqual([])
})

for (const scenario of [
  { mode: 'shell', width: 1024, height: 720, fontSize: 13, theme: 'light' },
  { mode: 'shell', width: 1440, height: 900, fontSize: 20, theme: 'dark' },
  { mode: 'quick', width: 480, height: 240, fontSize: 13, theme: 'light' },
  { mode: 'quick', width: 720, height: 420, fontSize: 16, theme: 'dark' },
]) test(`SSH suggestion geometry stays readable inside ${scenario.mode} ${scenario.width}×${scenario.height} ${scenario.theme}`, async ({ page }) => {
  await page.setViewportSize(scenario); await sshFixture(page, scenario.mode); await connectSsh(page)
  await applyWorkbenchTheme(page, scenario.theme)
  await page.evaluate(({ fontSize, theme }) => {
    document.documentElement.dataset.theme = theme
    window.SshWorkbenchBridge.store.setUi({ fontSize })
    window.SshWorkbenchBridge.activeSession().term.setFontSize(fontSize)
  }, scenario)
  await setCommand(page, 'docker '); await show(page)
  await expect(popup(page)).toBeVisible()
  const rect = await popup(page).boundingBox()
  expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0)
  expect(rect.x + rect.width).toBeLessThanOrEqual(scenario.width)
  expect(rect.y + rect.height).toBeLessThanOrEqual(scenario.height)
  const hint = page.locator('.wb-statusbar #hint-meta')
  await expect(hint).toHaveAttribute('title', '直接在终端输入，回车执行')
  await expect(hint).toHaveCSS('position', 'static')
  await expect(page.locator('.term-wrap #hint-meta')).toHaveCount(0)
  if (await hint.isVisible()) {
    const hintRect = await hint.boundingBox()
    const terminalBottom = await page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.el.getBoundingClientRect().bottom)
    expect(hintRect.y).toBeGreaterThanOrEqual(terminalBottom)
    expect(hintRect.x + hintRect.width).toBeLessThanOrEqual(scenario.width)
  }
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await page.screenshot({ path: `test-results-workbenches/ssh-completion-${scenario.mode}-${scenario.width}-${scenario.theme}.png` })
})
