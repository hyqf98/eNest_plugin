import { test, expect } from '@playwright/test'
import { sshFixture, connectSsh } from './ssh-fixture.js'

test('SSH tool rail hides connections without changing a session and remembers keyboard resizing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); await sshFixture(page)
  // Hold the delayed post-connect focus until a different workspace control owns focus.
  await page.evaluate(() => {
    const nativeTimeout = window.setTimeout
    window.__pendingConnectFocus = []
    window.setTimeout = (callback, delay, ...args) => delay === 50
      ? (window.__pendingConnectFocus.push(() => callback(...args)), 0)
      : nativeTimeout(callback, delay, ...args)
    window.__restoreConnectTimeout = () => { window.setTimeout = nativeTimeout }
  })
  const id = await connectSsh(page)
  await expect(page.locator('.wb-files')).not.toBeVisible()
  await expect(page.locator('[data-navigation="history"]')).toHaveAttribute('data-tip', '历史')
  const separator = page.getByRole('separator', { name: '连接面板宽度' })
  await separator.focus()
  await page.evaluate(() => { window.__restoreConnectTimeout(); window.__pendingConnectFocus.forEach(callback => callback()) })
  await expect(separator).toBeFocused()
  await page.keyboard.press('End'); await expect(separator).toHaveAttribute('aria-valuenow', '360')
  await page.locator('[data-navigation="connections"]').click(); await expect(page.locator('#side-body')).not.toBeVisible()
  expect(await page.evaluate(() => window.SshWorkbenchBridge.activeSession().sessionId)).toBe(id)
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'disconnect'))).toEqual([])
  await page.locator('[data-navigation="connections"]').click(); await page.evaluate(() => window.SshWorkbenchBridge.store.flushAll()); await page.reload()
  await expect(page.getByRole('separator', { name: '连接面板宽度' })).toHaveAttribute('aria-valuenow', '360')
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'connect'))).toEqual([])
  await expect(page.locator('.wb-session-status')).toContainText('尚未重新连接')
})

test('SSH narrow connection drawer returns focus on Escape and leaves a live terminal mounted', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 500 }); await sshFixture(page); const id = await connectSsh(page)
  await page.locator('[data-navigation="connections"]').click(); await expect(page.locator('#side-body')).toBeVisible()
  await page.keyboard.press('Escape'); await expect(page.locator('#side-body')).not.toBeVisible()
  await expect(page.locator('[data-navigation="connections"]')).toBeFocused()
  expect(await page.evaluate(() => window.SshWorkbenchBridge.activeSession().sessionId)).toBe(id)
  await expect(page.locator('.term-host').first()).toBeVisible()
})

test('SSH sidebar selection keeps the current execution target and session tabs have keyboard navigation', async ({ page }) => {
  await sshFixture(page); const first = await connectSsh(page); await connectSsh(page, 'ops')
  await page.locator('#tree [data-profile="dev"]').click()
  await expect(page.locator('.wb-session-target')).toContainText('operator@ops.example.test')
  await page.locator('#session-tabs [role="tab"][aria-selected="true"]').focus(); await page.keyboard.press('Home')
  await expect(page.locator('.wb-session-target')).toContainText('developer@dev.example.test')
  expect(await page.evaluate(() => window.SshWorkbenchBridge.activeSession().sessionId)).toBe(first)
})

test('SSH resources have aligned numeric columns and horizontal overflow within the task', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 }); await sshFixture(page); await connectSsh(page)
  await page.locator('[data-navigation="resources"]').click()
  const body = page.locator('.wb-tool-body'); await expect(body.locator('td').first()).toHaveText('2241')
  await expect(body.locator('td').nth(0)).toHaveCSS('text-align', 'right')
  await expect(body.locator('td').nth(1)).toHaveAttribute('title', 'application-worker-with-a-long-service-name')
  expect(await body.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await body.evaluate(element => { element.scrollLeft = element.scrollWidth }); expect(await body.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results-ssh/ssh-workspace-resources.png' })
})

test('SSH SFTP keeps clipped names discoverable and independent selection through view changes', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 500 }); await sshFixture(page); await connectSsh(page)
  // With the default 240px connection pane, this viewport leaves 436px for
  // 420px file rows. Widen the pane to exercise a genuinely constrained list.
  await page.getByRole('separator', { name: '连接面板宽度' }).focus(); await page.keyboard.press('End')
  await page.locator('[data-navigation="files"]').click()
  const row = page.locator('.wb-file-row').filter({ hasText: 'application-production-with-long-name.conf' })
  await expect(row).toHaveAttribute('title', './application-production-with-long-name.conf'); await row.click()
  await page.locator('[data-navigation="terminal"]').click(); await page.locator('[data-navigation="files"]').click()
  await expect(row).toHaveAttribute('aria-selected', 'true')
  const list = page.locator('.wb-file-list'); expect(await list.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await list.evaluate(element => { element.scrollLeft = element.scrollWidth }); await expect.poll(() => list.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results-ssh/ssh-workspace-files.png' })
})

test('SSH completion settings persist custom commands and keep the draft when persistence fails', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); await sshFixture(page); await connectSsh(page)
  await page.locator('[data-navigation="settings"]').click(); await page.locator('[data-section="completion"]').click()
  await page.locator('[data-add-command]').click(); await page.getByRole('textbox', { name: '自定义命令 1', exact: true }).fill('kubectl get pods')
  await page.getByRole('textbox', { name: '命令说明 1', exact: true }).fill('查看集群工作负载')
  await page.locator('[name="autoSuggest"]').uncheck(); await page.getByRole('button', { name: '保存命令提示设置', exact: true }).click()
  expect(await page.evaluate(() => window.__data['ssh.ui'].completion.userCommands[0])).toEqual({ command: 'kubectl get pods', description: '查看集群工作负载' })
  await page.evaluate(() => { window.__storageFail = true }); await page.getByRole('textbox', { name: '自定义命令 1', exact: true }).fill('kubectl get services')
  await page.getByRole('button', { name: '保存命令提示设置', exact: true }).click(); await expect(page.locator('.wb-settings-feedback')).toContainText('保存失败')
  await expect(page.getByRole('textbox', { name: '自定义命令 1', exact: true })).toHaveValue('kubectl get services')
  await page.screenshot({ path: 'test-results-ssh/ssh-workspace-settings.png' })
})

test('SSH connection completed after closing its source tab is released and cannot steal focus', async ({ page }) => {
  await sshFixture(page)
  await page.evaluate(() => { const connect = window.enest.ssh.connect; window.enest.ssh.connect = async payload => { const result = await connect(payload); await new Promise(resolve => { window.__releaseConnect = resolve }); return result }; window.__connecting = window.SshWorkbenchBridge.connectProfile(window.SshWorkbenchBridge.store.findProfile('dev')) })
  await expect.poll(() => page.evaluate(() => typeof window.__releaseConnect)).toBe('function')
  await page.locator('#session-tabs [data-close]').click(); await page.locator('#confirm-ok').click()
  await expect.poll(() => page.evaluate(() => window.SshWorkbenchBridge.sessions.size)).toBe(0)
  await page.evaluate(async () => { window.__releaseConnect(); await window.__connecting })
  expect(await page.evaluate(() => window.SshWorkbenchBridge.sessions.size)).toBe(0)
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'disconnect').length)).toBe(1)
})

test('SSH Quick round trip preserves a live session and connection drawer fits 480 by 240', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 420 }); await sshFixture(page, 'quick'); const id = await connectSsh(page)
  await page.evaluate(() => window.__mode('shell')); await page.evaluate(() => window.__mode('quick')); await page.setViewportSize({ width: 480, height: 240 })
  await page.locator('[data-navigation="connections"]').click(); await expect(page.locator('#side-body')).toBeVisible()
  expect(await page.locator('#side-body').evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
  await page.keyboard.press('Escape'); expect(await page.evaluate(() => window.SshWorkbenchBridge.activeSession().sessionId)).toBe(id)
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'disconnect'))).toEqual([])
  await page.screenshot({ path: 'test-results-ssh/ssh-workspace-quick.png' })
})
