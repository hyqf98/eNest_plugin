import { test, expect } from '@playwright/test'
import { fixture, connect, setQuery } from './database-fixture.js'

async function editorState(page, { start, end = start, crlf = false, undo = false, undoStop = false, insert } = {}) {
  return page.evaluate(async ({ start, end, crlf, undo, undoStop, insert }) => {
    const entry = performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name))
    const { monaco } = await import(entry.name), editor = monaco.editor.getEditors()[0], model = editor.getModel()
    if (crlf) model.setEOL(monaco.editor.EndOfLineSequence.CRLF)
    if (start !== undefined) {
      const from = model.getPositionAt(start), to = model.getPositionAt(end)
      editor.setSelection(new monaco.Selection(from.lineNumber, from.column, to.lineNumber, to.column))
    }
    if (undoStop) editor.pushUndoStop()
    if (insert !== undefined) { editor.executeEdits('execution-undo-fixture', [{ range: editor.getSelection(), text: insert }]); editor.pushUndoStop() }
    if (undo) await model.undo()
    editor.focus()
    return { value: model.getValue(), version: model.getVersionId(), selection: editor.getSelection() }
  }, { start, end, crlf, undo, undoStop, insert })
}

const executions = page => page.evaluate(() => window.__calls.filter(call => call[0] === 'execute').map(call => call[1].sql))

async function expectExecuted(page, expected) {
  await expect.poll(() => executions(page)).toEqual(expected)
  await expect(page.locator('[data-action=run]').first()).toBeEnabled()
}

test('toolbar executes the caret statement with Chinese, CRLF and quoted semicolons without editing the model', async ({ page }) => {
  await fixture(page); await connect(page)
  const source = "SELECT '第一条;内容';\r\n-- 第二条查询\r\nSELECT 名称, '第二条;内容' FROM 客户;\r\nSELECT 3;"
  await setQuery(page, source)
  const before = await editorState(page, { crlf: true, start: source.indexOf('名称') })
  await page.locator('[data-action=run]').first().click()
  await expectExecuted(page, ["-- 第二条查询\r\nSELECT 名称, '第二条;内容' FROM 客户;"])
  const after = await editorState(page)
  expect(after).toEqual(before)
})

test('execution shortcuts honor the second statement boundary and exact selection; whole-document execution stays explicit', async ({ page }) => {
  await fixture(page); await connect(page)
  const source = 'SELECT 1;SELECT 2;SELECT 3;'
  await setQuery(page, source)
  await editorState(page, { start: 9 })
  await page.keyboard.press('Control+Enter')
  await expectExecuted(page, ['SELECT 2;'])
  await editorState(page, { start: 18 })
  await page.keyboard.press('F5')
  await expectExecuted(page, ['SELECT 2;', 'SELECT 3;'])
  await editorState(page, { start: 0, end: 9 })
  await page.keyboard.press('Control+Enter')
  await expectExecuted(page, ['SELECT 2;', 'SELECT 3;', 'SELECT 1;'])
  await editorState(page, { start: 9, end: 18 })
  await page.keyboard.press('Control+Shift+Enter')
  await expectExecuted(page, ['SELECT 2;', 'SELECT 3;', 'SELECT 1;', source])
  expect((await editorState(page)).value).toBe(source)
})

test('select-all then execute sends the whole selection and preserves the undo stack', async ({ page }) => {
  await fixture(page); await connect(page)
  const source = 'SELECT 1;\nSELECT 2;'
  await setQuery(page, source)
  await editorState(page, { start: source.length, undoStop: true, insert: ' -- 保留撤销' })
  const edited = (await editorState(page)).value
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Control+Enter')
  await expectExecuted(page, [edited])
  expect((await editorState(page, { undo: true })).value).toBe(source)
})

test('procedure caret execution keeps the guarded DELETE inside its complete definition; transactions stay explicit', async ({ page }) => {
  await fixture(page); await connect(page)
  const definition = 'CREATE PROCEDURE p() BEGIN IF 1=0 THEN DELETE FROM audit WHERE id=-1; END IF; SELECT 2; END;'
  const source = `${definition} SELECT 3;`
  await setQuery(page, source)
  const before = await editorState(page, { start: source.indexOf('DELETE') })
  await page.keyboard.press('Control+Enter')
  await expectExecuted(page, [definition])
  expect(await editorState(page)).toEqual(before)
  await editorState(page, { start: source.indexOf('SELECT 3') })
  await page.keyboard.press('Control+Enter')
  await expectExecuted(page, [definition, 'SELECT 3;'])
  const transactions = 'BEGIN; SELECT 1; COMMIT;'
  await setQuery(page, transactions)
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Control+Enter')
  await expectExecuted(page, [definition, 'SELECT 3;', transactions])
  expect((await executions(page)).some(sql => /^DELETE\b/.test(sql))).toBe(false)
})

test('MySQL DELIMITER caret normalizes one routine while selected scripts preserve their directives for the host', async ({ page }) => {
  await fixture(page); await connect(page)
  const definition = 'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END'
  const source = `DELIMITER $$\n${definition}$$\nDELIMITER ;\nSELECT 3;`
  await setQuery(page, source)
  const before = await editorState(page, { start: source.indexOf('SELECT 2') })
  await page.locator('[data-action=run]').first().click()
  await expectExecuted(page, [definition])
  expect(await editorState(page)).toEqual(before)
  await editorState(page, { start: source.indexOf('SELECT 3') })
  await page.keyboard.press('F5')
  await expectExecuted(page, [definition, 'SELECT 3;'])
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Control+Enter')
  await expectExecuted(page, [definition, 'SELECT 3;', source])
  await setQuery(page, 'SELECT 1;\nDELIMITER invalid\nSELECT 2;')
  await page.keyboard.press('Control+Shift+Enter')
  await expect(page.locator('#local-toast')).toContainText('Invalid DELIMITER')
  expect(await executions(page)).toEqual([definition, 'SELECT 3;', source])
})

// Seed an alternate adapter in the same saved-connection contract, then exercise its real
// editor/navigation path. The workbench API remains a mock; these are not server tests.
async function dialectFixture(page, driver) {
  await fixture(page, 'shell', { connectionDriver: driver })
  const connection = page.locator('.nav-connections [data-connection="dev"]')
  await expect(connection.locator('.nav-connection-name')).toHaveText(`${driver} fixture`)
  await expect(connection.locator('.nav-connection-detail')).toContainText(driver === 'mssql' ? 'SQL Server' : 'Oracle')
  expect(await page.evaluate(() => window.__data['db.connections'].find(item => item.id === 'dev').driver)).toBe(driver)
  await connect(page)
}

test('SQL Server caret sends the whole GO batch with DECLARE/guard scope and refuses repeat counts', async ({ page }) => {
  await dialectFixture(page, 'mssql')
  const batch = 'DECLARE @n INT = 0; IF @n=1 BEGIN DELETE FROM audit WHERE id=-1; END; SELECT @n;'
  const source = `${batch}\nGO\nSELECT 3;`
  await setQuery(page, source)
  await editorState(page, { start: source.indexOf('DELETE') })
  await page.keyboard.press('Control+Enter')
  await expectExecuted(page, [batch])
  await editorState(page, { start: source.indexOf('SELECT 3') })
  await page.keyboard.press('Control+Enter')
  await expectExecuted(page, [batch, 'SELECT 3;'])
  await page.keyboard.press('Control+Shift+Enter')
  await expectExecuted(page, [batch, 'SELECT 3;', source])
  await setQuery(page, `${batch}\nGO 2\nSELECT 3;`)
  await page.keyboard.press('Control+Shift+Enter')
  await expect(page.locator('#local-toast')).toContainText('GO repeat counts')
  expect(await executions(page)).toEqual([batch, 'SELECT 3;', source])
})

test('Oracle caret keeps labelled PL/SQL intact and q-quoted semicolons inside the following query', async ({ page }) => {
  await dialectFixture(page, 'oracle')
  const block = '<<guarded>> BEGIN IF 1=0 THEN DELETE FROM audit WHERE id=-1; END IF; END;'
  const query = "SELECT q'[a';b]' AS value FROM dual;"
  const source = `${block}\n/\n${query}`
  await setQuery(page, source)
  const before = await editorState(page, { start: source.indexOf('DELETE') })
  await page.keyboard.press('Control+Enter')
  await expectExecuted(page, [block])
  expect(await editorState(page)).toEqual(before)
  await editorState(page, { start: source.indexOf("a';b") })
  await page.keyboard.press('Control+Enter')
  await expectExecuted(page, [block, query])
  await page.keyboard.press('Control+Shift+Enter')
  await expectExecuted(page, [block, query, source])
  expect((await editorState(page)).value).toBe(source)
})

test('cancelling a running script after switching tabs targets its original execution and keeps both models', async ({ page }) => {
  await fixture(page); await connect(page)
  const source = 'SELECT source_one; SELECT source_two;'
  await setQuery(page, source)
  const sourceTab = await page.locator('#workspace-tabs [role=tab][aria-selected=true]').getAttribute('data-workspace-tab')
  await page.evaluate(() => { window.__deferExecution = true })
  await page.keyboard.press('Control+Shift+Enter')
  await expect.poll(() => page.evaluate(() => window.__pendingExecutions.length)).toBe(1)
  const request = await page.evaluate(() => window.__pendingExecutions[0].input)
  expect(request.sql).toBe(source)
  await connect(page, 'analytics')
  await setQuery(page, 'SELECT untouched_destination;')
  const destinationTab = await page.locator('#workspace-tabs [role=tab][aria-selected=true]').getAttribute('data-workspace-tab')
  await page.keyboard.press('Alt+Escape')
  await expect.poll(() => page.evaluate(() => window.__calls.filter(call => call[0] === 'cancel').map(call => ({ sessionKey: call[1].sessionKey, executionId: call[1].executionId })))).toEqual([{ sessionKey: request.sessionKey, executionId: request.executionId }])
  await expect(page.locator('#workspace-tabs [role=tab][aria-selected=true]')).toHaveAttribute('data-workspace-tab', destinationTab)
  expect((await editorState(page)).value).toBe('SELECT untouched_destination;')
  expect(await executions(page)).toEqual([source])
  await page.locator(`#workspace-tabs [role=tab][data-workspace-tab="${sourceTab}"]`).click()
  await expect(page.locator('#results')).toContainText('查询已取消')
  expect((await editorState(page)).value).toBe(source)
})

test('lightweight editor has the same current/selection/all execution semantics', async ({ page }) => {
  await page.route('**/monaco-*.js', route => route.abort())
  await fixture(page); await connect(page)
  const editor = page.locator('textarea[aria-label="查询编辑器"]'), source = "SELECT 'one;value';SELECT 2;"
  await editor.fill(source)
  await editor.evaluate(element => { element.focus(); element.setSelectionRange(element.value.indexOf('SELECT 2'), element.value.indexOf('SELECT 2')) })
  await editor.press('Control+Enter')
  await expectExecuted(page, ['SELECT 2;'])
  await editor.evaluate(element => { element.focus(); element.setSelectionRange(0, element.value.indexOf('SELECT 2')) })
  await editor.press('F5')
  await expectExecuted(page, ['SELECT 2;', "SELECT 'one;value';"])
  await editor.press('ControlOrMeta+a'); await editor.press('Control+Enter')
  await expectExecuted(page, ['SELECT 2;', "SELECT 'one;value';", source])
  await expect(editor).toHaveValue(source)
})
