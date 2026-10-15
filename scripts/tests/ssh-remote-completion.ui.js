import { test, expect } from '@playwright/test'
import { sshFixture, connectSsh, setCommand } from './ssh-fixture.js'

const popup = page => page.locator('.ssh-command-suggestions')
const show = page => page.evaluate(() => window.SshWorkbenchBridge.runCompletion(true))
const command = page => page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.readCommand()?.text)
const writes = page => page.evaluate(() => window.__calls.filter(([kind]) => kind === 'write').map(([, value]) => value))

async function prepare(page, options = {}) {
  await sshFixture(page); const sessionId = await connectSsh(page)
  await page.evaluate(options => {
    window.__remotePending = []
    window.__remoteDirectories = options.directories || {}
    window.__remoteCommands = options.commands || 'nebula\0node\0docker\0'
    window.__remoteDelay = false; window.__remoteFail = false
    window.enest.ssh.sftp.list = async input => {
      window.__calls.push(['remote.list', input])
      if (window.__remoteFail) throw new Error('permission denied')
      const entries = window.__remoteDirectories[input.path] || []
      if (window.__remoteDelay) await new Promise(resolve => window.__remotePending.push(resolve))
      return entries
    }
    window.enest.ssh.exec = async input => { window.__calls.push(['remote.exec', input]); return { stdout: window.__remoteCommands, stderr: '', exitCode: 0 } }
    window.SshWorkbenchBridge.store.setUi({ completion: { remotePaths: true, remoteCommands: !!options.enableCommands } })
    window.dispatchEvent(new Event('ssh-completion-settings-change'))
    window.__calls.length = 0
  }, options)
  return sessionId
}

test('remote SFTP paths share the caret list and append escaped Chinese names without execution', async ({ page }) => {
  const sessionId = await prepare(page, { directories: { '/home/developer/': [{ name: '报告 1.txt', type: 'file' }, { name: "报告'2.txt", type: 'file' }] } })
  await setCommand(page, 'cat /home/developer/报'); await show(page)
  const candidate = page.locator('[data-source="remote-path"]').filter({ hasText: '报告 1.txt' })
  await expect(candidate).toBeVisible(); await expect(candidate).toContainText('远端 SFTP')
  expect(await writes(page)).toEqual([])
  await candidate.click()
  await expect.poll(() => command(page)).toBe('cat /home/developer/报告\\ 1.txt')
  expect(await writes(page)).toEqual([{ sessionId, data: '告\\ 1.txt' }])
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => ['executed', 'remote.exec'].includes(kind)))).toEqual([])
  await expect(page.locator('dialog[open], .modal-root.show')).toHaveCount(0)
})

test('quoted directory acceptance waits for echo then offers children in the same anchored list', async ({ page }) => {
  await prepare(page, { directories: {
    '/home/developer/': [{ name: '项目 空间', type: 'dir' }],
    '/home/developer/项目 空间/': [{ name: '子目录', type: 'dir' }]
  } })
  await setCommand(page, "cd '/home/developer/项"); await show(page)
  await page.locator('.ssh-command-name').filter({ hasText: '项目 空间/' }).click()
  await expect.poll(() => command(page)).toBe("cd '/home/developer/项目 空间/'")
  await expect(page.locator('.ssh-command-name').filter({ hasText: '子目录/' })).toBeVisible()
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'executed'))).toEqual([])
})

test('remote PATH is opt-in, read through a fixed independent command and deduplicated with local names', async ({ page }) => {
  await prepare(page, { enableCommands: true })
  await setCommand(page, 'ne'); await show(page)
  const candidate = page.locator('[data-source="remote-command"]').filter({ hasText: 'nebula' })
  await expect(candidate).toBeVisible(); await expect(candidate).toContainText('独立会话')
  expect(await writes(page)).toEqual([])
  const requests = await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'remote.exec').map(([, value]) => value))
  expect(requests).toHaveLength(1); expect(requests[0].command).toContain('set -- $PATH'); expect(requests[0].timeoutMs).toBe(4500)
  await candidate.click(); await expect.poll(() => command(page)).toBe('nebula')
  await setCommand(page, 'doc'); await show(page)
  await expect(page.locator('.ssh-command-name').filter({ hasText: /^docker$/ })).toHaveCount(1)
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'remote.exec').length)).toBe(1)
})

test('Escape permanently dismisses an in-flight remote response until a new explicit request', async ({ page }) => {
  await prepare(page, { directories: { '/tmp/': [{ name: 'remote.txt', type: 'file' }] } })
  await page.evaluate(() => { window.__remoteDelay = true })
  await setCommand(page, 'cat /tmp/re'); await show(page)
  await expect.poll(() => page.evaluate(() => window.__remotePending.length)).toBe(1)
  await page.keyboard.press('Escape'); await expect(popup(page)).toHaveCount(0)
  await page.evaluate(() => { window.__remoteDelay = false; window.__remotePending.splice(0).forEach(resolve => resolve()) })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(popup(page)).toHaveCount(0)
  expect(await writes(page)).toEqual([])
  await expect.poll(() => command(page)).toBe('cat /tmp/re')
  await show(page); await expect(page.locator('.ssh-command-name')).toHaveText(['remote.txt'])
})

test('switching the server retires delayed remote candidates and does not redirect writes', async ({ page }) => {
  await prepare(page, { directories: { '/tmp/': [{ name: 'remote.txt', type: 'file' }] } })
  await page.evaluate(() => { window.__remoteDelay = true })
  await setCommand(page, 'cat /tmp/re'); await show(page)
  await expect.poll(() => page.evaluate(() => window.__remotePending.length)).toBe(1)
  const second = await connectSsh(page, 'ops')
  await page.evaluate(() => { window.__remoteDelay = false; window.__remotePending.splice(0).forEach(resolve => resolve()); window.__calls.length = 0 })
  await expect(popup(page)).toHaveCount(0); expect(await writes(page)).toEqual([])
  await setCommand(page, 'cat /tmp/re'); await show(page)
  await page.locator('.ssh-command-name').filter({ hasText: 'remote.txt' }).click()
  await expect.poll(() => command(page)).toBe('cat /tmp/remote.txt')
  expect(await writes(page)).toEqual([{ sessionId: second, data: 'mote.txt' }])
})

test('untrusted prompts and pending echo make no remote reads, and failures keep local candidates', async ({ page }) => {
  await prepare(page)
  await page.evaluate(() => { const s = window.SshWorkbenchBridge.activeSession(); window.__sshData(s.sessionId, '\x1b]133;C\x07\r\nPassword: ') })
  await expect.poll(() => command(page)).toBe(undefined)
  await show(page)
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind.startsWith('remote.')))).toEqual([])
  await setCommand(page, 'cat /tmp/re'); await page.evaluate(() => { window.__sshEcho = false }); await page.keyboard.type('p'); await show(page)
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind.startsWith('remote.')))).toEqual([])
  await page.evaluate(() => {
    window.__sshEcho = true; window.__remoteFail = true
    window.SshWorkbenchBridge.store.setUi({ completion: { remotePaths: true, userCommands: [{ command: 'cat /tmp/readme', description: '本地片段' }] } })
    window.dispatchEvent(new Event('ssh-completion-settings-change'))
  })
  await setCommand(page, 'cat /tmp/re'); await show(page)
  await expect(popup(page)).toContainText('本地提示仍可使用')
  await expect(page.locator('.ssh-command-name').filter({ hasText: 'cat /tmp/readme' })).toBeVisible()
})

test('settings expose source defaults and disabling remote reads takes effect immediately', async ({ page }) => {
  await prepare(page)
  await page.locator('[data-navigation="settings"]').click(); await page.locator('[data-section="completion"]').click()
  await expect(page.locator('input[name="remotePaths"]')).toBeChecked()
  await expect(page.locator('input[name="remoteCommands"]')).not.toBeChecked()
  await expect(page.locator('.wb-remote-completion-settings')).toContainText('临时修改的 PATH')
  await page.locator('input[name="remotePaths"]').uncheck(); await page.locator('.wb-completion-settings button[type="submit"]').click()
  await page.locator('.wb-settings-page [data-back]').click(); await setCommand(page, 'cat /tmp/re'); await show(page)
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind.startsWith('remote.')))).toEqual([])
  await expect(popup(page)).toHaveCount(0)
})
