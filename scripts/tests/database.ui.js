import { test, expect } from '@playwright/test'

async function fixture(page, mode = 'shell') {
  await page.addInitScript(({ mode }) => {
    // Same strict JSON contract as the host: IPC/storage never retains references.
    const strictClone = (value) => {
      const seen = new Set()
      const visit = (item) => {
        if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return
        if (!item || typeof item !== 'object') throw new Error('storage requires finite JSON data')
        if (seen.has(item)) throw new Error('storage JSON contains a cycle')
        if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('storage requires plain JSON objects')
        seen.add(item)
        if (Array.isArray(item)) { for (let i = 0; i < item.length; i++) visit(item[i]) }
        else { if (Object.getOwnPropertySymbols(item).length) throw new Error('storage requires string keys'); for (const entry of Object.values(item)) visit(entry) }
        seen.delete(item)
      }
      visit(value); return JSON.parse(JSON.stringify(value))
    }
    const dbs = [{ id: 'dev', name: '订单库 · 开发', driver: 'mysql', host: '127.0.0.1', port: 3306, database: 'orders', env: 'dev', favorite: true }, { id: 'analytics', name: '时序分析', driver: 'tdengine', host: '127.0.0.1', port: 6041, database: 'telemetry' }]
    const data = { 'db.connections': dbs, 'db.sessions': [], 'db.queryHistory': [] }
    const result = { columns: [{ name: 'id', type: 'int', primaryKey: true }, { name: 'name', type: 'varchar' }], rows: [[1, '阿尔法'], [2, '贝塔']], rowCount: 2, durationMs: 4, editable: true, rowIdentity: { keyColumns: ['id'], keys: [[1], [2]] } }
    window.__data = data; window.__sessions = {}; window.__calls = []; window.__toasts = []; window.__mode = () => {}; window.__entered = () => {}
    window.enest = {
      getLaunchMode: async () => mode, onModeChange: (callback) => window.__mode = callback, onEnter: (callback) => window.__entered = callback, onBeforeClose() {},
      shell: { saveTextFile: async (input) => { window.__calls.push(['saveTextFile', input]); return { ok: true, path: `/tmp/${input.defaultName}` } } },
      storage: { get: async (key) => data[key] === undefined ? undefined : strictClone(data[key]), set: async (key, value) => { if (window.__storageFail) throw new Error('存储空间不足'); if (window.__storageReject) return false; data[key] = strictClone(value); return true } },
      settings: { register: async () => {}, get: async () => true },
      ui: { setTitle: async () => {}, toast: async (input) => window.__toasts.push(input), setInputContext: async (context) => window.__context = context, openInShell: async () => { window.__mode('shell'); return true }, focusSearch: async () => true },
      vault: { set: async () => { if (window.__vaultFail) throw new Error('凭据库不可用'); return 'secret:test' } }, clipboard: { writeText: async () => true }, notify: async () => true,
      db: {
        pickSqliteFile: async (options = {}) => { window.__calls.push(['pickSqliteFile', options]); return window.__cancelFile ? null : { id: 'sqlite-authorized', name: 'enest-regression.sqlite', displayPath: '/tmp/enest-regression.sqlite', kind: 'file', size: 0 } },
        open: async (request) => { window.__calls.push(['open', request]); window.__sessions[request.sessionKey] = request.config; return { sessionKey: request.sessionKey } }, close: async () => {}, test: async () => ({ ok: true }),
        schema: { tree: async (request) => request.parent === 'root' ? [{ type: 'database', name: 'orders' }] : [{ type: 'table', name: 'customers' }], describe: async () => ({ name: 'customers', columns: [{ name: 'id', type: 'INT', primaryKey: true }, { name: 'name', type: 'VARCHAR(255)', nullable: true }], indexes: [], foreignKeys: [] }), ddl: async () => 'CREATE TABLE customers (id INT PRIMARY KEY);' },
        workbench: async ({ action, input }) => {
          window.__calls.push([action, input])
          if (['execute', 'table.page'].includes(action) && input.surface === 'quick' && !window.__sessions[input.sessionKey]?.readOnly) throw new Error('Quick requires an independent read-only console')
          if (action === 'drivers.list') return ['mysql', 'tdengine', 'mongodb', 'sqlite', 'duckdb', 'influxdb2'].map((id) => ({ id, label: id === 'mysql' ? 'MySQL' : id, family: 'sql', language: 'sql', transport: 'native', capabilities: Object.fromEntries(['query', 'schema', 'edit', 'crud', 'explain', 'transaction', 'compare', 'ddl', 'tablePage', 'tableDesign'].map((key) => [key, { state: 'available' }])) }))
          if (action === 'execute') return { executionId: input.executionId, results: [window.__manyRows ? { ...result, rows: Array.from({ length: window.__manyRows }, (_, i) => [i + 1, `item-${i + 1}`]), rowCount: window.__manyRows } : window.__documentResult ? { ...result, columns: [{ name: 'document' }], rows: [[{ _id: { $oid: 'abc' }, user: { name: 'Ada', active: true }, metrics: [1, 2, null] }]], format: 'document', editable: false } : result], state: 'completed' }
          if (action === 'browse') return result
          if (action === 'table.page') {
            if (!window.__serverRows) return { ...result, page: { offset: input.offset || 0, limit: input.limit, hasMore: !input.offset, stableOrder: true } }
            const limit = input.surface === 'quick' ? Math.min(200, input.limit) : input.limit, offset = input.offset || 0
            const all = Array.from({ length: window.__serverRows }, (_, i) => [i + 1, `item-${i + 1}`]).filter((row) => (input.filters || []).every((filter) => String(row[filter.column === 'id' ? 0 : 1]).includes(String(filter.value))))
            return { ...result, rows: all.slice(offset, offset + limit), page: { offset, limit, hasMore: offset + limit < all.length, stableOrder: true } }
          }
          if (action === 'table.design.preview') return { statements: ['CREATE TABLE example (id INT)'], sql: 'CREATE TABLE example (id INT);', warnings: [], destructive: false }
          if (action === 'table.design.apply') return { state: 'completed', results: [result] }
          if (action === 'inspect') return { kind: input.kind, state: input.kind === 'locks' ? 'permission-denied' : 'available', source: input.kind === 'client' ? 'enest-client' : 'database-server', sampledAt: Date.now(), columns: [{ name: 'active' }, { name: 'idle' }], rows: [[1, 0]], reason: '当前用户没有读取锁信息的权限' }
          if (action === 'compare') return { columnMappings: input.columnMappings, left: result, right: { ...result, rows: [[1, '阿尔法'], [2, '更新']] }, rows: [{ key: '1', status: 'equal', left: [1, '阿尔法'], right: [1, '阿尔法'] }, { key: '2', status: 'different', left: [2, '贝塔'], right: [2, '更新'] }], partial: false, comparedAt: Date.now() }
          if (action === 'transaction' || action === 'cancel') return { ok: true }
          return { items: [] }
        }
      }
    }
  }, { mode })
  await page.goto('/plugins/com.enest.database/index.html')
  await expect(page.locator('.wb-home h1')).toBeAttached()
}

test('Quick is keyboard navigable at 480×240 and defers Monaco until query', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 240 }); const external = []
  page.on('request', (request) => { if (!request.url().startsWith(`http://127.0.0.1:${process.env.DB_UI_PORT || 4178}`) && !request.url().startsWith('data:')) external.push(request.url()) })
  await fixture(page, 'quick')
  await expect(page.locator('.wb-search')).toBeFocused()
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)))).toBe(false)
  await page.screenshot({ path: 'test-results-db/database-quick-home.png' })
  await page.keyboard.press('ArrowUp'); await expect(page.locator('[data-connect=analytics]')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
  await page.evaluate(async () => { const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name); const editor = monaco.editor.getEditors()[0]; editor.executeEdits('test', [{ range: editor.getModel().getFullModelRange(), text: 'SELECT id, name FROM customers;' }]); editor.focus() })
  await page.locator('[data-action=run]').click()
  await expect.poll(() => page.evaluate(() => window.__calls.find((call) => call[0] === 'execute')?.[1]?.maxRows)).toBe(200)
  await page.mouse.move(475, 235)
  await expect(page.locator('.wb-status')).toBeInViewport({ ratio: 1 }); await expect(page.locator('[data-action=run]')).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: 'test-results-db/database-quick-query.png' })
  await page.locator('[data-expand-results]').click(); await expect(page.locator('.grid-viewport')).toBeVisible(); await expect(page.locator('[data-expand-results]')).toHaveText('返回查询'); await page.screenshot({ path: 'test-results-db/database-quick-expanded.png' }); await page.locator('[data-export-results]').click(); await expect.poll(() => page.evaluate(() => window.__calls.find((call) => call[0] === 'saveTextFile')?.[1]?.content)).toContain('阿尔法')
  await page.locator('[data-expand-results]').click(); await page.setViewportSize({ width: 720, height: 420 }); await expect(page.locator('.wb-status')).toBeInViewport({ ratio: 1 }); await page.mouse.move(710, 10); await page.screenshot({ path: 'test-results-db/database-quick-query-720.png' })
  expect(external).toEqual([])
})

test('mode migration retains model, undo and selection; Quick uses separate session', async ({ page }) => {
  await fixture(page)
  await page.locator('[data-connect=dev]').click(); await expect(page.locator('.monaco-editor').first()).toBeVisible()
  await page.evaluate(async () => { const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name); const editor = monaco.editor.getEditors()[0]; editor.executeEdits('test', [{ range: editor.getModel().getFullModelRange(), text: 'SELECT 1;' }]); editor.getModel().pushStackElement(); window.__desktopKey = window.__calls.find((call) => call[0] === 'open')[1].sessionKey; window.__mode('quick') })
  await page.locator('[data-wb=home]').click(); await page.locator('[data-connect=dev]').click()
  const keys = await page.evaluate(() => window.__calls.filter((call) => call[0] === 'open').map((call) => call[1].sessionKey))
  expect(new Set(keys).size).toBe(2)
  const before = await page.evaluate(async () => { const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name); const editor = monaco.editor.getEditors()[0]; editor.executeEdits('test', [{ range: editor.getModel().getFullModelRange(), text: 'SELECT 2;' }]); editor.getModel().pushStackElement(); editor.executeEdits('test', [{ range: new monaco.Range(1, 8, 1, 9), text: '3' }]); editor.getModel().pushStackElement(); editor.setSelection(new monaco.Range(1, 1, 1, 7)); return { id: editor.getModel().id, selection: editor.getSelection() } })
  await page.locator('[data-wb=openShell]').click()
  const after = await page.evaluate(async () => { const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name); const editor = monaco.editor.getEditors()[0]; const result = { id: editor.getModel().id, selection: editor.getSelection() }; await editor.getModel().undo(); return { ...result, text: editor.getValue() } })
  expect(after.id).toBe(before.id); expect(after.selection).toEqual(before.selection); expect(after.text).toBe('SELECT 2;')
})

test('workbench resources, settings, structure and comparison are usable', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message))
  await fixture(page); await page.locator('[data-connect=dev]').click(); await expect(page.locator('.monaco-editor').first()).toBeVisible()
  await page.locator('[data-wb=resources]').click(); await expect(page.getByText('本插件创建的连接', { exact: true })).toBeVisible()
  await page.locator('[data-kind=locks]').click(); await expect(page.getByText('权限不足', { exact: true })).toBeVisible()
  await page.locator('[data-wb=settings]').click(); await expect(page.getByRole('heading', { name: '数据库设置' })).toBeVisible()
  await page.locator('[data-wb=structure]').click(); await page.locator('[data-object=customers]').click(); await expect(page.getByRole('heading', { name: '关系图' })).toBeVisible()
  await page.locator('[data-wb=compare]').click(); await page.getByRole('button', { name: '最大化比较窗口' }).click(); await expect(page.locator('.wb-compare-dialog')).toHaveClass(/is-maximized/); await page.getByRole('button', { name: '恢复比较窗口' }).click(); await page.locator('summary').filter({ hasText: '列映射与比较规则' }).click(); await page.locator('[data-add-mapping]').click(); await page.locator('[data-mapping][data-prop=left]').fill('name'); await page.locator('[data-mapping][data-prop=right]').fill('name'); await page.locator('[data-add-mapping]').click(); await page.locator('[data-mapping="1"][data-prop=left]').fill('id'); await page.locator('[data-mapping="1"][data-prop=right]').fill('id'); await page.locator('[data-mapping="1"][data-prop=rule]').selectOption('numeric'); await page.locator('[data-query=left]').fill('SELECT * FROM customers'); await page.locator('[data-query=right]').fill('SELECT * FROM customers'); await page.locator('[data-keys]').fill('id'); await page.locator('[data-compare]').click()
  await expect(page.locator('.wb-compare-summary')).toContainText('1 项差异'); await expect(page.locator('[data-pane=left] th').nth(1)).toHaveText('name'); await expect(page.locator('[data-pane=left] tbody tr').first().locator('td').nth(1)).toHaveText('阿尔法'); await expect(page.locator('[data-pane=left]')).toBeVisible(); await expect(page.locator('[data-pane=right]')).toBeVisible()
  await page.locator('[data-export]').click(); await expect.poll(() => page.evaluate(() => window.__calls.filter((call) => call[0] === 'saveTextFile').at(-1)?.[1]?.filename)).toMatch(/comparison\.json$/); await page.screenshot({ path: 'test-results-db/database-comparison.png' }); await page.keyboard.press('Escape')
  await page.locator('[data-wb=query]').click(); await page.screenshot({ path: 'test-results-db/database-workbench.png' }); expect(errors).toEqual([])
})


test('connection form adapts to drivers and never saves a secret when vault fails', async ({ page }) => {
  await fixture(page); await page.locator('[data-new]').click()
  await page.locator('[data-k=driver]').selectOption('duckdb'); await expect(page.locator('[data-k=fileLabel]')).toBeVisible(); await expect(page.locator('[data-k=host]')).toBeHidden()
  await page.locator('[data-k=driver]').selectOption('mongodb'); await page.locator('[data-k=name]').fill('文档库'); await page.locator('[data-k=uri]').fill('mongodb://localhost:27017'); await page.locator('[data-k=secret]').fill('do-not-persist')
  await page.evaluate(() => window.__vaultFail = true); await page.locator('[data-act=save]').click(); await expect(page.locator('[data-el=form-hint]')).toContainText('凭据库不可用'); expect(await page.evaluate(() => window.__data['db.connections'].length)).toBe(2)
  await page.evaluate(() => window.__vaultFail = false); await page.locator('[data-k=uri]').fill('mongodb://user:unsafe@localhost:27017'); await page.locator('[data-act=save]').click(); await expect(page.locator('[data-el=form-hint]')).toContainText('不能包含密码')
  await page.locator('[data-k=uri]').fill('mongodb://localhost:27017'); await page.locator('[data-act=save]').click(); await expect(page.locator('dialog')).toHaveCount(0)
  const saved = await page.evaluate(() => window.__data['db.connections'].find((connection) => connection.name === '文档库')); expect(saved.secretRef).toBe('secret:test'); expect(JSON.stringify(saved)).not.toContain('do-not-persist')
})

test('table design previews structured operations; data paging, sort and filter run on server', async ({ page }) => {
  await fixture(page); await page.locator('[data-connect=dev]').click(); await page.locator('[data-wb=structure]').click(); await page.locator('[data-create-table]').click()
  await page.locator('[data-table]').fill('example'); await page.locator('[data-prop=name]').fill('id'); await expect(page.locator('[data-apply]')).toBeDisabled(); await page.locator('[data-preview]').click(); await expect(page.getByRole('textbox', { name: 'DDL 预览' })).toContainText('CREATE TABLE'); expect(await page.evaluate(() => window.__calls.some((call) => call[0] === 'table.design.apply'))).toBe(false)
  await page.locator('[data-apply]').click(); await expect(page.locator('[data-status]')).toHaveText('表设计已应用'); const design = await page.evaluate(() => window.__calls.find((call) => call[0] === 'table.design.apply')[1]); expect(design.confirmed).toBe(true); expect(design.design.operation).toBe('create-table'); expect(design).not.toHaveProperty('sql'); await page.keyboard.press('Escape')
  await page.locator('[data-object=customers]').click(); await page.locator('[data-browse]').click(); await expect(page.locator('.wb-server-pager')).toContainText('服务器分页'); await page.locator('[data-server-next]').click(); await expect.poll(() => page.evaluate(() => window.__calls.filter((call) => call[0] === 'table.page').at(-1)[1].offset)).toBe(200)
  await page.locator('.grid-head .th[data-c="1"]').click(); await expect.poll(() => page.evaluate(() => window.__calls.filter((call) => call[0] === 'table.page').at(-1)[1].order)).toEqual([{ column: 'name', direction: 'asc' }])
  await page.locator('[data-server-filter]').click(); await page.locator('[data-add-filter]').click(); await page.locator('[data-prop=value]').fill('42'); await page.locator('[data-apply-filter]').click(); await expect.poll(() => page.evaluate(() => window.__calls.filter((call) => call[0] === 'table.page').at(-1)[1].filters)).toEqual([{ column: 'id', operator: 'eq', value: 42 }]); await page.screenshot({ path: 'test-results-db/database-server-page.png' })
})


test('document results open a typed, collapsible inspector and Escape restores the query surface', async ({ page }) => {
  await fixture(page); await page.locator('[data-connect=dev]').click(); await expect(page.locator('.monaco-editor').first()).toBeVisible()
  await page.evaluate(async () => { window.__documentResult = true; const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name); monaco.editor.getEditors()[0].setValue('SELECT document FROM records;') })
  await page.locator('[data-action=run]').click(); await page.locator('.grid-viewport [data-r="0"][data-c="0"]').dblclick(); await expect(page.locator('.wb-document-tree')).toContainText('object'); await page.locator('summary').filter({ hasText: 'user' }).click(); await expect(page.locator('.wb-document-tree')).toContainText('Ada'); await page.screenshot({ path: 'test-results-db/database-document-tree.png' }); await page.keyboard.press('Escape'); await expect(page.locator('dialog')).toHaveCount(0)
})

test('SQLite save is durable; storage errors retain input and never announce success', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message))
  await fixture(page); await page.locator('[data-new]').click()
  await page.locator('[data-k=driver]').selectOption('sqlite'); await page.locator('[data-k=name]').fill('本地回归库'); await page.locator('[data-act=pick-sqlite]').click(); await expect(page.locator('[data-k=fileLabel]')).toHaveAttribute('readonly', '')
  await page.evaluate(() => window.__storageFail = true); await page.locator('[data-act=save]').click()
  await expect(page.locator('[data-el=form-hint]')).toContainText('保存失败：存储空间不足'); await expect(page.locator('[data-k=fileLabel]')).toHaveValue('/tmp/enest-regression.sqlite')
  expect(await page.evaluate(() => window.__data['db.connections'].length)).toBe(2)
  expect(await page.evaluate(() => window.__toasts.some((item) => item.type === 'success' && item.message.includes('保存')))).toBe(false)
  await page.locator('[data-act=close]').click(); await expect(page.locator('[data-connect]')).toHaveCount(2)
  await page.locator('[data-new]').click(); await page.locator('[data-k=driver]').selectOption('sqlite'); await page.locator('[data-k=name]').fill('本地回归库'); await page.locator('[data-act=pick-sqlite]').click(); await expect(page.locator('[data-k=fileLabel]')).toHaveAttribute('readonly', '')
  await page.evaluate(() => { window.__storageFail = false; window.__storageReject = true }); await page.locator('[data-act=save]').click(); await expect(page.locator('[data-el=form-hint]')).toContainText('保存失败：宿主拒绝写入')
  await page.evaluate(() => window.__storageReject = false); await page.locator('[data-act=save]').click(); await expect(page.locator('dialog')).toHaveCount(0)
  const saved = await page.evaluate(() => window.__data['db.connections'].find((connection) => connection.name === '本地回归库'))
  expect(saved.driver).toBe('sqlite'); expect(saved.fileHandleId).toBe('sqlite-authorized'); expect(saved.fileLabel).toBe('/tmp/enest-regression.sqlite'); expect(saved).not.toHaveProperty('filePath'); expect(saved).not.toHaveProperty('sqlitePath'); expect(Object.hasOwn(saved, 'port')).toBe(false)
  expect(await page.evaluate(() => window.__toasts.filter((item) => item.type === 'success' && item.message === '连接已保存').length)).toBe(1)
  expect(errors).toEqual([])
})

test('Quick expanded results page and filter migrated loaded data at 480×240', async ({ page }) => {
  await fixture(page); await page.locator('[data-connect=dev]').click(); await expect(page.locator('.monaco-editor').first()).toBeVisible()
  await page.evaluate(async () => { window.__manyRows = 1000; const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name); monaco.editor.getEditors()[0].setValue('SELECT id, name FROM customers;') })
  await page.locator('[data-action=run]').click(); await expect(page.locator('[data-loaded-range]')).toContainText('/ 1000 行')
  await page.locator('[data-pager-select=size]').evaluate((select) => { select.value = '50'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await page.evaluate(() => window.__mode('quick')); await page.setViewportSize({ width: 480, height: 240 }); await page.locator('[data-wb=query]').click()
  await expect(page.locator('.wb-session-note')).toContainText('桌面控制台，请在桌面执行'); await expect(page.locator('[data-action=run]')).toHaveCount(0)
  const priorCalls = await page.evaluate(() => window.__calls.filter((call) => ['open', 'execute'].includes(call[0])).length)
  await page.keyboard.press('Meta+Enter'); expect(await page.evaluate(() => window.__calls.filter((call) => ['open', 'execute'].includes(call[0])).length)).toBe(priorCalls)
  await page.screenshot({ path: 'test-results-db/database-quick-desktop-preview.png' }); await page.locator('[data-expand-results]').click()
  await expect(page.locator('[data-loaded-range]')).toContainText('1–50 / 1000 行 · 已加载分页'); await page.locator('[data-pager=next]').click(); await expect(page.locator('[data-loaded-range]')).toContainText('51–100 / 1000')
  await page.locator('[data-pager=prev]').click(); await expect(page.locator('[data-loaded-range]')).toContainText('1–50 / 1000')
  await page.locator('[data-quick-filter-column]').selectOption('name'); await page.locator('[data-quick-filter-text]').fill('item-999'); await expect(page.locator('[data-loaded-range]')).toContainText('1–1 / 1 行'); await expect(page.locator('.grid-viewport')).toContainText('item-999')
  await page.locator('[data-export-results]').click(); await expect.poll(() => page.evaluate(() => window.__calls.filter((call) => call[0] === 'saveTextFile').at(-1)?.[1]?.content)).toContain('item-999')
  await page.locator('[data-quick-filter-text]').fill('no-such-row'); await expect(page.locator('[data-loaded-range]')).toContainText('0–0 / 0 行'); await page.locator('[data-quick-filter-clear]').click(); await expect(page.locator('[data-loaded-range]')).toContainText('1–50 / 1000')
  await expect(page.locator('.wb-status')).toBeInViewport({ ratio: 1 }); await expect(page.locator('[data-pager=next]')).toBeInViewport({ ratio: 1 }); await expect(page.locator('[data-quick-filter-text]')).toBeInViewport({ ratio: 1 }); await page.mouse.move(470, 232); await page.screenshot({ path: 'test-results-db/database-quick-paging.png' })
  await page.locator('[data-expand-results]').click(); await page.locator('[data-action=newQuick]').click(); await expect(page.locator('[data-action=run]')).toBeVisible()
  const models = await page.evaluate(async () => { const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name); return { active: monaco.editor.getEditors()[0].getValue(), values: monaco.editor.getModels().map((model) => model.getValue()), calls: window.__calls.filter((call) => ['open', 'execute'].includes(call[0])).length } })
  expect(models.active).toBe(''); expect(models.values).toContain('SELECT id, name FROM customers;'); expect(models.calls).toBe(priorCalls)
})

test('Quick expanded server results fetch pages and clear server filters', async ({ page }) => {
  await fixture(page, 'quick'); await page.evaluate(() => window.__serverRows = 1500); await page.locator('[data-connect=dev]').click(); await page.locator('[data-wb=openShell]').click(); await page.locator('[data-wb=structure]').click(); await page.locator('[data-object=customers]').click(); await page.locator('[data-browse]').click()
  await page.getByRole('combobox', { name: '服务器每页行数' }).selectOption('1000'); await expect(page.locator('.wb-server-pager')).toContainText('1–1000 行')
  await page.evaluate(() => window.__mode('quick')); await page.setViewportSize({ width: 480, height: 240 }); await page.locator('[data-wb=query]').click(); await page.locator('[data-expand-results]').click(); await expect(page.locator('.wb-server-pager')).toBeInViewport({ ratio: 1 }); await page.locator('[data-server-next]').click()
  await expect(page.locator('.wb-server-pager')).toContainText('1001–1200 行'); const request = await page.evaluate(() => window.__calls.filter((call) => call[0] === 'table.page').at(-1)[1]); expect(request.offset).toBe(1000); expect(request.limit).toBe(200); expect(request.surface).toBe('quick')
  await page.locator('[data-server-prev]').click(); await expect(page.locator('.wb-server-pager')).toContainText('801–1000 行')
  await page.locator('[data-quick-filter-column]').selectOption('name'); await page.locator('[data-quick-filter-text]').fill('item-1499'); await page.locator('[data-quick-filter-apply]').click(); await expect(page.locator('.wb-server-pager')).toContainText('1–1 行 · 1 条件'); await expect(page.locator('.grid-viewport')).toContainText('item-1499'); await expect(page.locator('[data-server-next]')).toBeDisabled()
  await page.locator('[data-quick-filter-clear]').click(); await expect(page.locator('.wb-server-pager')).toContainText('1–200 行'); expect(await page.evaluate(() => window.__calls.filter((call) => call[0] === 'table.page').at(-1)[1].filters)).toEqual([])
  await expect(page.locator('.wb-status')).toBeInViewport({ ratio: 1 }); await expect(page.locator('[data-server-next]')).toBeInViewport({ ratio: 1 }); await page.mouse.move(470, 232); await page.screenshot({ path: 'test-results-db/database-quick-server-paging.png' })
})


test('local database picker cancellation does not invent authority; new file uses save picker', async ({ page }) => {
  await fixture(page); await page.locator('[data-new]').click()
  await page.locator('[data-k=driver]').selectOption('sqlite'); await page.locator('[data-k=name]').fill('新建文件')
  await page.evaluate(() => window.__cancelFile = true); await page.locator('[data-act=pick-sqlite]').click()
  await page.locator('[data-act=save]').click(); await expect(page.locator('[data-el=form-hint]')).toContainText('请选择并授权')
  expect(await page.evaluate(() => window.__data['db.connections'].length)).toBe(2)
  await page.evaluate(() => window.__cancelFile = false); await page.locator('[data-act=create-sqlite]').click()
  expect(await page.evaluate(() => window.__calls.at(-1))).toEqual(['pickSqliteFile', { createIfMissing: true }])
  await page.locator('[data-act=save]').click(); await expect(page.locator('dialog')).toHaveCount(0)
  const saved = await page.evaluate(() => window.__data['db.connections'].find(connection => connection.name === '新建文件'))
  expect(saved.fileHandleId).toBe('sqlite-authorized'); expect(saved.createIfMissing).toBe(true)
})
