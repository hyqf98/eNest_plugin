import { expect } from '@playwright/test'

export async function fixture(page, mode = 'shell', { connectionDriver } = {}) {
  await page.addInitScript(({ mode, connectionDriver }) => {
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
    const data = JSON.parse(sessionStorage.getItem('database-fixture-storage') || 'null') || { 'db.connections': dbs, 'db.sessions': [], 'db.queryHistory': [] }
    // Seed before plugin boot. Mutating a running app's mock storage then reloading can
    // race its pending persistence and restore the old in-memory connection instead.
    if (connectionDriver) data['db.connections'] = data['db.connections'].map(connection => connection.id === 'dev' ? { ...connection, driver: connectionDriver, dialect: connectionDriver, name: `${connectionDriver} fixture` } : connection)
    const result = { columns: [{ name: 'id', type: 'int', primaryKey: true }, { name: 'name', type: 'varchar' }], rows: [[1, '阿尔法'], [2, '贝塔']], rowCount: 2, durationMs: 4, editable: true, rowIdentity: { keyColumns: ['id'], keys: [[1], [2]] } }
    window.__data = data; window.__sessions = {}; window.__calls = []; window.__toasts = []; window.__pendingExecutions = []; window.__pendingCatalog = []; window.__busySessions = new Set(); window.__mode = () => {}; window.__entered = () => {}
    const assertIdle = (action, sessionKey) => {
      if (!window.__strictSessionTasks || !window.__busySessions.has(sessionKey)) return
      window.__calls.push(['busy-rejected', { action, sessionKey }])
      throw new Error('This console is busy with schema discovery')
    }
    const schemaTask = async (action, request, response) => {
      assertIdle(action, request.sessionKey)
      if (!window.__strictSessionTasks) return response
      window.__busySessions.add(request.sessionKey)
      try {
        const catalog = request.sessionKey.startsWith('db-nav:catalog:') || !request.sessionKey.startsWith('db-nav:')
        if (window.__deferCatalog && action === 'schema.tree' && catalog) await new Promise(resolve => window.__pendingCatalog.push({ request, finish: resolve }))
        if (action === 'schema.describe') await new Promise(resolve => setTimeout(resolve, 15))
        return catalog && action === 'schema.tree' ? [...response, { type: 'table', name: 'invoices' }, { type: 'table', name: 'products' }] : response
      } finally { window.__busySessions.delete(request.sessionKey) }
    }
    window.enest = {
      getLaunchMode: async () => mode, onModeChange: (callback) => window.__mode = callback, onEnter: (callback) => window.__entered = callback, onBeforeClose: callback => { window.__beforeClose = callback },
      shell: { saveTextFile: async (input) => { window.__calls.push(['saveTextFile', input]); return { ok: true, path: `/tmp/${input.defaultName}` } } },
      storage: { get: async (key) => data[key] === undefined ? undefined : strictClone(data[key]), set: async (key, value) => { if (window.__storageFail) throw new Error('存储空间不足'); if (window.__storageReject) return false; data[key] = strictClone(value); sessionStorage.setItem('database-fixture-storage', JSON.stringify(data)); return true } },
      settings: { register: async () => {}, get: async () => true },
      ui: { setTitle: async () => {}, toast: async (input) => window.__toasts.push(input), setInputContext: async (context) => window.__context = context, openInShell: async () => { window.__mode('shell'); return true }, focusSearch: async () => true },
      vault: { set: async () => { if (window.__vaultFail) throw new Error('凭据库不可用'); return 'secret:test' } }, clipboard: { writeText: async () => true }, notify: async () => true,
      db: {
        importPreview: async input => {
          window.__calls.push(['importPreview', input])
          const rows = input.csvText.trim().split(/\r?\n/).map(line => line.split(input.options.delimiter))
          const columns = input.options.hasHeader ? rows.shift() : rows[0].map((_, index) => `col${index + 1}`)
          return { columns, sampleRows: rows.slice(0, 20), totalRowsEstimate: rows.length }
        },
        importRun: async input => { window.__calls.push(['importRun', input]); return { inserted: 1, failed: 0 } },
        pickSqliteFile: async (options = {}) => { window.__calls.push(['pickSqliteFile', options]); return window.__cancelFile ? null : { id: 'sqlite-authorized', name: 'enest-regression.sqlite', displayPath: '/tmp/enest-regression.sqlite', kind: 'file', size: 0 } },
        open: async (request) => { window.__calls.push(['open', request]); window.__sessions[request.sessionKey] = request.config; return { sessionKey: request.sessionKey } }, close: async (sessionKey) => { window.__calls.push(['close', sessionKey]); delete window.__sessions[sessionKey] }, test: async () => ({ ok: true }),
        applyChanges: async input => { window.__calls.push(['applyChanges', input]); const response = { results: input.changes.map((_, index) => ({ index, ok: true })) }; if (window.__deferBatch) return new Promise(resolve => { window.__finishBatch = () => resolve(response) }); return response },
        schema: {
          tree: async (request) => {
            window.__calls.push(['schema.tree', request])
            const parent = request.node?.type || request.parent || 'root', database = request.database || window.__sessions[request.sessionKey]?.database || 'orders'
            if (parent === 'root') return schemaTask('schema.tree', request, [{ type: 'database', name: database, database, expandable: true }])
            if (['database', 'schema'].includes(parent)) return schemaTask('schema.tree', request, [{ type: 'table', name: 'customers', database, expandable: true }])
            if (parent === 'table') return schemaTask('schema.tree', request, [{ type: 'column', name: 'id', expandable: false }, { type: 'column', name: 'name', expandable: false }])
            return schemaTask('schema.tree', request, [])
          },
          describe: async request => { window.__calls.push(['schema.describe', request]); return schemaTask('schema.describe', request, { name: request.table || 'customers', columns: [{ name: 'id', type: 'INT', primaryKey: true }, { name: 'name', type: 'VARCHAR(255)', nullable: true }], indexes: [], foreignKeys: [] }) },
          ddl: async () => 'CREATE TABLE customers (id INT PRIMARY KEY);'
        },
        workbench: async ({ action, input }) => {
          window.__calls.push([action, input])
          if (['execute', 'table.page'].includes(action)) assertIdle(action, input.sessionKey)
          if (['execute', 'table.page'].includes(action) && input.surface === 'quick' && !window.__sessions[input.sessionKey]?.readOnly) throw new Error('Quick requires an independent read-only console')
          if (action === 'drivers.list') return [...new Set(['mysql', 'tdengine', 'mongodb', 'sqlite', 'duckdb', 'influxdb2', ...(connectionDriver ? [connectionDriver] : [])])].map((id) => ({ id, label: id === 'mysql' ? 'MySQL' : id, family: 'sql', language: 'sql', transport: 'native', capabilities: Object.fromEntries(['query', 'schema', 'edit', 'crud', 'explain', 'transaction', 'compare', 'ddl', 'tablePage', 'tableDesign'].map((key) => [key, { state: 'available' }])) }))
          if (action === 'execute') {
            const response = { executionId: input.executionId, results: [window.__manyRows ? { ...result, rows: Array.from({ length: window.__manyRows }, (_, i) => [i + 1, `item-${i + 1}`]), rowCount: window.__manyRows } : window.__documentResult ? { ...result, columns: [{ name: 'document' }], rows: [[{ _id: { $oid: 'abc' }, user: { name: 'Ada', active: true }, metrics: [1, 2, null] }]], format: 'document', editable: false } : window.__queryEcho ? { ...result, rows: [[1, input.sql]] } : result], state: 'completed' }
            if (window.__deferExecution) return new Promise((resolve, reject) => window.__pendingExecutions.push({ input, finish: () => resolve(response), reject }))
            return response
          }
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
          if (action === 'transaction') return { ok: true, active: input.operation === 'begin' }
          if (action === 'cancel') { window.__pendingExecutions.splice(0).forEach(item => item.reject(new Error('查询已取消'))); return { ok: true } }
          return { items: [] }
        }
      }
    }
  }, { mode, connectionDriver })
  await page.goto('/plugins/com.enest.database/index.html')
  await expect(page.locator('.nav-connections')).toBeAttached()
}

export async function openNavigation(page) {
  const panel = page.locator('.nav-connections')
  const visible = await panel.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.right > 40 && rect.left >= 0 && getComputedStyle(element).visibility !== 'hidden' })
  if (!visible) await page.locator('#side-toggle').click()
  await expect(panel).toBeInViewport()
}

export async function connect(page, id = 'dev') {
  await openNavigation(page)
  await page.locator(`[data-connect="${id}"]`).click()
  await expect(page.locator('#workspace-tabs [role=tab][aria-selected=true]')).toBeVisible()
}

export async function navigate(page, destination) {
  await openNavigation(page)
  await page.locator(`[data-nav="${destination}"]`).click()
}

export async function openObject(page, view = 'data', connectionId = 'dev') {
  await openNavigation(page)
  const connection = page.locator(`[data-connection="${connectionId}"]`)
  const toggle = connection.locator('[data-expand-connection]')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  const database = connection.locator('.nav-tree-row').filter({ has: page.locator('[data-object="orders"], [data-object="telemetry"]') }).first()
  await expect(database).toBeVisible()
  if (await database.locator('[data-toggle]').getAttribute('aria-expanded') !== 'true') await database.locator('[data-toggle]').click()
  const table = connection.locator('.nav-tree-row').filter({ has: page.locator('[data-object=customers]') })
  await expect(table).toBeVisible()
  await table.hover()
  await table.locator(`[data-open-object][data-view="${view}"]`).click()
  if (view === 'structure' && await page.locator('[data-read-definition]').isVisible()) await page.locator('[data-read-definition]').click()
}

export async function setQuery(page, value) {
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
  await page.evaluate(async text => {
    const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name)
    const editor = monaco.editor.getEditors()[0]
    editor.executeEdits('test', [{ range: editor.getModel().getFullModelRange(), text }]); editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus()
  }, value)
}
