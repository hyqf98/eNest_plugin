import { test, expect } from '@playwright/test'
import { sshFixture, connectSsh, setCommand } from './ssh-fixture.js'

const writes = page => page.evaluate(() => window.__calls.filter(([kind]) => kind === 'write').map(([, value]) => value))
async function selectOutput(page, text, current = '') {
  await page.evaluate(({ text, current }) => { const s = window.SshWorkbenchBridge.activeSession(); window.__sshData(s.sessionId, '\x1b]133;C\x07\r\n' + text + '\r\n'); window.__sshPrompt(current) }, { text, current })
  await expect.poll(() => page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.readCommand()?.text)).toBe(current)
  await page.evaluate(text => { const term = window.SshWorkbenchBridge.activeSession().term.raw; const buffer = term.buffer.active; for (let index = buffer.length - 1; index >= 0; index--) if (buffer.getLine(index)?.translateToString(true) === text) { term.select(0, index, text.length); return }; throw new Error('Selection output not found') }, text)
  await expect(page.locator('[data-insert-selection]')).toBeVisible()
  await page.evaluate(() => { window.__calls.length = 0 })
}

test('selected terminal text can be quickly appended from the toolbar without executing', async ({ page }) => {
  await sshFixture(page); const sessionId = await connectSsh(page)
  await selectOutput(page, 'echo selected', 'echo '); await page.locator('[data-insert-selection]').click()
  await expect.poll(() => page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.readCommand()?.text)).toBe('echo selected')
  expect(await writes(page)).toEqual([{ sessionId, data: 'selected' }])
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'executed'))).toEqual([])
})

test('explicit selected-command execution writes once, submits once and records one history entry', async ({ page }) => {
  await sshFixture(page); const sessionId = await connectSsh(page)
  await selectOutput(page, 'echo selected'); await page.locator('[data-execute-selection]').click()
  await expect.poll(() => page.evaluate(() => window.__calls.filter(([kind]) => kind === 'executed').length)).toBe(1)
  expect(await writes(page)).toEqual([{ sessionId, data: 'echo selected\r' }])
  expect(await page.evaluate(() => window.SshWorkbenchBridge.store.state.history.filter(item => item.command === 'echo selected').length)).toBe(1)
})

test('quick execute refuses multiline, untrusted and unacknowledged terminal input', async ({ page }) => {
  await sshFixture(page); await connectSsh(page); await setCommand(page, '')
  expect(await page.evaluate(() => window.SshWorkbenchBridge.runHint('echo first\necho second'))).toBe(false)
  await page.evaluate(() => { const s = window.SshWorkbenchBridge.activeSession(); window.__sshData(s.sessionId, '\x1b]133;C\x07\r\nPassword: ') })
  await expect.poll(() => page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.readCommand())).toBe(null)
  await page.evaluate(() => { window.__calls.length = 0 })
  expect(await page.evaluate(() => window.SshWorkbenchBridge.runHint('echo unsafe'))).toBe(false); expect(await writes(page)).toEqual([])
  await setCommand(page, 'echo '); await page.evaluate(() => { window.__sshEcho = false }); await page.keyboard.type('x'); await page.evaluate(() => { window.__calls.length = 0 })
  expect(await page.evaluate(() => window.SshWorkbenchBridge.runHint('echo x'))).toBe(false); expect(await writes(page)).toEqual([])
})

test('danger confirmation cannot redirect a selected command to a different server', async ({ page }) => {
  await sshFixture(page); await connectSsh(page); await selectOutput(page, 'rm -rf /tmp/demo')
  await page.locator('[data-execute-selection]').click(); await expect(page.locator('#confirm-root')).toHaveClass(/show/)
  await connectSsh(page, 'ops'); await page.evaluate(() => { window.__calls.length = 0 }); await page.locator('#confirm-ok').click()
  await expect(page.locator('#confirm-root')).not.toHaveClass(/show/)
  await expect.poll(() => page.evaluate(() => window.__toasts.some(value => JSON.stringify(value).includes('目标会话已变化')))).toBe(true)
  expect(await writes(page)).toEqual([])
})

test('completion acceptance is configurable and the caret list explains actual Enter semantics', async ({ page }) => {
  await sshFixture(page); await connectSsh(page)
  const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control')
  await page.locator('[data-navigation="settings"]').click(); await page.locator('[data-section="shortcuts"]').click()
  const input = page.locator('[data-binding="completion-accept"]'); await input.focus(); await page.keyboard.press(`${modifier}+Shift+L`)
  await expect(input).toHaveValue(/(?:Command|Ctrl)\+Shift\+L/)
  await page.locator('.wb-settings-page [data-back]').click(); await setCommand(page, 'doc'); await page.evaluate(() => window.SshWorkbenchBridge.runCompletion(true))
  await expect(page.locator('.ssh-command-keys')).toContainText('Shift+L')
  await expect(page.locator('.ssh-command-keys')).toContainText('Enter 执行当前命令')
  await expect(page.locator('.ssh-command-keys')).not.toContainText('↩')
  await page.evaluate(() => { window.__calls.length = 0 }); await page.keyboard.press(`${modifier}+Shift+L`)
  await expect.poll(() => page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.readCommand()?.text)).toBe('docker')
  expect((await writes(page)).map(value => value.data)).toEqual(['ker'])
})

test('settings can enable session hints directly and cancel a switched target before dispatch', async ({ page }) => {
  await sshFixture(page); await connectSsh(page); await connectSsh(page, 'ops')
  await page.locator('[data-navigation="settings"]').click(); await page.locator('[data-section="completion"]').click()
  await page.locator('[data-enable-session-hints]').click(); await expect(page.locator('#confirm-root')).toHaveClass(/show/)
  await page.evaluate(() => { const b = window.SshWorkbenchBridge; b.setActiveTab([...b.sessions.values()].find(s => s.profileId === 'dev').tabId); window.__calls.length = 0 })
  await page.locator('#confirm-ok').click(); await expect(page.locator('.wb-settings-feedback')).toContainText('目标会话已变化')
  expect(await page.evaluate(() => window.__calls.filter(([kind, value]) => kind === 'workbench' && value.action === 'shell.integrate'))).toEqual([])
  await page.locator('[data-enable-session-hints]').click(); await page.locator('#confirm-ok').click()
  await expect.poll(() => page.evaluate(() => window.__calls.filter(([kind, value]) => kind === 'workbench' && value.action === 'shell.integrate').length)).toBe(1)
})

test('explicit remote-history actions forward arrows without filling local candidates or submitting', async ({ page }) => {
  await sshFixture(page); const sessionId = await connectSsh(page); await setCommand(page, 'echo typed')
  await page.evaluate(() => { window.__calls.length = 0; return window.SshWorkbenchBridge.navigateHistory(-1) })
  await expect.poll(() => page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.readCommand()?.text)).toBe('echo remote-history')
  await page.evaluate(() => window.SshWorkbenchBridge.navigateHistory(1))
  await expect.poll(() => page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.readCommand()?.text)).toBe('')
  expect(await writes(page)).toEqual([{ sessionId, data: '\x1b[A' }, { sessionId, data: '\x1b[B' }])
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'executed'))).toEqual([])
})
