import { test, expect } from '@playwright/test'
import { sshFixture, connectSsh, setCommand } from './ssh-fixture.js'

const writes = page => page.evaluate(() => window.__calls.filter(([kind]) => kind === 'write'))

async function selectCurrentCommand(page, command = 'echo selected') {
  await setCommand(page, command)
  await page.evaluate(length => {
    const term = window.SshWorkbenchBridge.activeSession().term.raw, buffer = term.buffer.active
    term.select(9, buffer.baseY + buffer.cursorY, length)
  }, command.length)
  await expect.poll(() => page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.getSelection())).toBe(command)
}

test('IME Enter and arrow keys stay in the command palette until composition is complete', async ({ page }) => {
  await sshFixture(page); await connectSsh(page); await selectCurrentCommand(page)
  await page.locator('[data-command=palette]').click()
  const input = page.locator('.wb-palette-search')
  await input.fill('执行终端选中命令')
  await expect(page.locator('.wb-palette-items [role=option]')).toHaveCount(1)
  const before = await writes(page)
  await input.dispatchEvent('compositionstart', { data: '命令' })
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) {
    await input.dispatchEvent('keydown', { key, code: key, isComposing: true, bubbles: true, cancelable: true })
    await expect(input).toBeVisible()
    expect(await writes(page)).toEqual(before)
  }
  await input.dispatchEvent('compositionend', { data: '命令' })
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true })
  await expect(input).toBeVisible()
  expect(await writes(page)).toEqual(before)
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => window.__calls.filter(([kind]) => kind === 'executed').map(([, value]) => value.command))).toEqual(['echo selected'])
})

test('terminal selection shortcuts cannot execute from settings inputs or the remote file editor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await sshFixture(page); await connectSsh(page); await selectCurrentCommand(page)
  const before = await writes(page)
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform))
  await page.locator('[data-navigation=settings]').click()
  const settingInput = page.locator('.wb-settings-page input[name=fontSize]')
  await settingInput.focus()
  await settingInput.dispatchEvent('keydown', { key: 'R', code: 'KeyR', ctrlKey: !mac, metaKey: mac, shiftKey: true, bubbles: true, cancelable: true })
  expect(await writes(page)).toEqual(before)
  await page.locator('[data-back]').click()
  await page.locator('[data-navigation=files]').click()
  await page.locator('.wb-file-row').filter({ hasText: 'application-production-with-long-name.conf' }).dblclick()
  const remoteInput = page.locator('.wb-editor-pane .monaco-editor textarea').first()
  await expect(remoteInput).toBeAttached(); await remoteInput.focus()
  await remoteInput.dispatchEvent('keydown', { key: 'R', code: 'KeyR', ctrlKey: !mac, metaKey: mac, shiftKey: true, bubbles: true, cancelable: true })
  expect(await writes(page)).toEqual(before)
  await page.locator('[data-navigation=terminal]').click()
  await selectCurrentCommand(page)
  await page.keyboard.press('ControlOrMeta+Shift+R')
  await expect.poll(() => page.evaluate(() => window.__calls.filter(([kind]) => kind === 'executed').map(([, value]) => value.command))).toEqual(['echo selected'])
})
