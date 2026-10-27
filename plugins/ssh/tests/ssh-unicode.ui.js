import { test, expect } from '@playwright/test'
import { sshFixture, connectSsh, setCommand } from './ssh-fixture.js'

const readCommand = page => page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.readCommand())
const suggestions = page => page.locator('.ssh-command-suggestions')

// End-of-line fixture writes are valid Unicode; CSI movement below deliberately uses terminal cells,
// not the fixture's UTF-16 cursor redraw, so wide glyphs exercise the actual vendored xterm buffer.
test('Chinese, emoji and combining text retain UTF-16 command offsets when appending a suggestion', async ({ page }) => {
  await sshFixture(page); await connectSsh(page)
  const text = 'echo 中文🙂 e\u0301 👩‍💻 | doc'
  await setCommand(page, text)
  expect(await readCommand(page)).toMatchObject({ text, cursor: text.length })
  await page.evaluate(() => window.SshWorkbenchBridge.runCompletion(true))
  await expect(page.locator('.ssh-command-name').filter({ hasText: /^docker$/ })).toBeVisible()
  await page.evaluate(() => { window.__calls.length = 0 })
  await page.locator('.ssh-command-name').filter({ hasText: /^docker$/ }).click()
  await expect.poll(async () => (await readCommand(page))?.text).toBe(text + 'ker')
  expect(await page.evaluate(() => window.__calls.filter(([kind]) => kind === 'write').map(([, value]) => value.data))).toEqual(['ker'])
})

test('a cursor move after full-width Chinese uses terminal cells and cannot accept at the wrong JS offset', async ({ page }) => {
  await sshFixture(page); const id = await connectSsh(page)
  const text = 'echo 中文🙂 | doc'
  await setCommand(page, text)
  await page.evaluate(id => window.__sshData(id, '\x1b[3D'), id)
  await expect.poll(async () => (await readCommand(page))?.cursor).toBe(text.length - 3)
  expect((await readCommand(page))?.text).toBe(text)
  await page.evaluate(() => window.SshWorkbenchBridge.runCompletion(true))
  await expect(suggestions(page)).toHaveCount(0)
  await page.evaluate(id => window.__sshData(id, '\x1b[3C'), id)
  await expect.poll(async () => (await readCommand(page))?.cursor).toBe(text.length)
  await page.evaluate(() => window.SshWorkbenchBridge.runCompletion(true))
  await expect(suggestions(page)).toBeVisible()
})

test('a wide glyph soft wrap does not invent a space in the actual command', async ({ page }) => {
  await sshFixture(page); await connectSsh(page)
  // 9 prompt cells + 10 ASCII cells leave one cell; 中 must wrap instead of occupying that gap.
  const text = 'x'.repeat(10) + '中 | doc'
  await page.evaluate(text => {
    const session = window.SshWorkbenchBridge.activeSession()
    session.term.raw.resize(20, 24)
    window.__sshPrompt(text)
  }, text)
  await expect.poll(async () => (await readCommand(page))?.text).toBe(text)
  expect((await readCommand(page))?.cursor).toBe(text.length)
})

test('Chinese output with CRLF stays readable, selection copies Unicode and history preserves the command', async ({ page }) => {
  await sshFixture(page); const id = await connectSsh(page)
  await page.evaluate(id => window.__sshData(id, '\x1b]133;C\x07\r\n中文第一行\r\n第二行 🙂\r\n'), id)
  const text = 'echo 中文🙂'
  await setCommand(page, text)
  const output = await page.evaluate(() => {
    const buffer = window.SshWorkbenchBridge.activeSession().term.raw.buffer.active
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) || '').join('\n')
  })
  expect(output).toContain('中文第一行\n第二行 🙂')
  expect(output).not.toMatch(/[\r\uFFFD]/)
  await page.evaluate(() => {
    const bridge = window.SshWorkbenchBridge, term = bridge.activeSession().term.raw
    bridge.store.setUi({ selectCopy: true })
    term.select(9, term.buffer.active.baseY + term.buffer.active.cursorY, term.cols - 9)
  })
  await expect.poll(() => page.evaluate(() => window.__copied?.trimEnd())).toBe(text)
  await page.evaluate(() => { const term = window.SshWorkbenchBridge.activeSession().term; term.raw.clearSelection(); term.focus() })
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.SshWorkbenchBridge.store.state.history[0]?.command)).toBe(text)
})

test('binary UTF-8 chunks split inside a Chinese character keep a session-local streaming decoder', async ({ page }) => {
  await sshFixture(page); await connectSsh(page); await setCommand(page, '')
  await page.evaluate(() => {
    const id = window.SshWorkbenchBridge.activeSession().sessionId
    const bytes = new TextEncoder().encode('中文')
    window.__sshData(id, bytes.slice(0, 2))
    window.__sshData(id, bytes.slice(2, 4))
    window.__sshData(id, bytes.slice(4))
  })
  await expect.poll(async () => (await readCommand(page))?.text).toBe('中文')
})

test('a remote shell deleting a whole combining grapheme releases the echo barrier without guessing text', async ({ page }) => {
  await sshFixture(page); await connectSsh(page); await setCommand(page, 'echo e\u0301')
  await page.evaluate(() => {
    const session = window.SshWorkbenchBridge.activeSession()
    session.term.noteInput('\x7f')
    // One visible grapheme occupies one terminal cell; this is actual server echo, not local editing.
    window.__sshData(session.sessionId, '\b \b')
  })
  await expect.poll(async () => (await readCommand(page))?.text).toBe('echo ')
})

test('IME composition and unacknowledged Unicode input cannot apply stale completion text', async ({ page }) => {
  await sshFixture(page); await connectSsh(page); await setCommand(page, 'doc')
  await page.evaluate(() => window.SshWorkbenchBridge.runCompletion(true))
  await expect(suggestions(page)).toBeVisible()
  const textarea = page.locator('.active-terminal textarea')
  await textarea.dispatchEvent('compositionstart', { data: '中' })
  await expect(suggestions(page)).toHaveCount(0)
  expect(await readCommand(page)).toBeNull()
  await textarea.dispatchEvent('compositionend', { data: '中' })
  await page.evaluate(() => { window.__sshEcho = false })
  await page.keyboard.insertText('中文')
  await expect.poll(() => readCommand(page)).toBeNull()
  await page.evaluate(() => window.SshWorkbenchBridge.runCompletion(true))
  await expect(suggestions(page)).toHaveCount(0)
  await page.evaluate(() => { window.__sshEcho = true; window.__sshPrompt('doc中文') })
  await expect.poll(async () => (await readCommand(page))?.text).toBe('doc中文')
})
