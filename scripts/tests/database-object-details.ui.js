import { test, expect } from '@playwright/test'
import { fixture, connect, openNavigation } from './database-fixture.js'

async function metadataFixture(page) {
  await fixture(page)
  await page.evaluate(() => {
    const workbench = window.enest.db.workbench, tree = window.enest.db.schema.tree
    window.enest.db.schema.tree = async request => {
      const nodes = await tree(request)
      return request.node?.type === 'database' ? [...nodes, { type: 'view', name: 'active_customers', database: 'orders', expandable: false }] : nodes
    }
    const result = object => ({ columns: Object.keys(object).map(name => ({ name })), rows: [Object.values(object)] })
    window.enest.db.workbench = async request => {
      const { action, input } = request
      if (action !== 'execute' || !/information_schema\.|^SHOW CREATE /i.test(input.sql)) return workbench(request)
      window.__calls.push(['execute', input])
      const sql = input.sql
      let value
      if (/ROUTINE_NAME AS name/.test(sql)) value = result({ name: input.params[1] === 'PROCEDURE' ? 'reconcile_orders' : 'customer_total', comment: '订单汇总' })
      else if (/TRIGGER_NAME AS name/.test(sql)) value = result({ name: 'audit_order_change', related_table: 'orders' })
      else if (/EVENT_NAME AS name/.test(sql)) value = result({ name: 'nightly_summary', status: 'ENABLED' })
      else if (/information_schema.PARAMETERS/.test(sql)) value = { columns: ['position', 'mode', 'name', 'data_type'].map(name => ({ name })), rows: input.params[2] === 'PROCEDURE' ? [[1, 'IN', 'p_customer', 'BIGINT'], [2, 'OUT', 'p_total', 'DECIMAL(12,2)'], [3, 'INOUT', 'p_cursor', 'BIGINT']] : [[0, null, null, 'DECIMAL(12,2)'], [1, 'IN', 'p_customer', 'BIGINT']] }
      else if (/information_schema.ROUTINES/.test(sql)) value = result({ definition: 'BEGIN SELECT SUM(total) INTO p_total FROM orders WHERE customer_id = p_customer; END', return_type: 'DECIMAL(12,2)', deterministic: 'NO', data_access: 'READS SQL DATA', security: 'DEFINER', definer: 'report_reader@localhost', created: '2026-10-01', altered: '2026-10-14', comment: '汇总指定客户的订单金额' })
      else if (/information_schema.TRIGGERS/.test(sql)) value = result({ definition: 'INSERT INTO audit_log(order_id) VALUES (NEW.id)', related_table: 'orders', manipulation: 'UPDATE', timing: 'AFTER', orientation: 'ROW', definer: 'report_reader@localhost', sql_mode: 'STRICT_TRANS_TABLES' })
      else if (/information_schema.EVENTS/.test(sql)) value = result({ definition: 'CALL orders.reconcile_orders(0, @total, @cursor)', event_type: 'RECURRING', interval_value: '1', interval_field: 'DAY', status: 'ENABLED', time_zone: 'SYSTEM', definer: 'report_reader@localhost' })
      else if (/information_schema.VIEWS/.test(sql)) value = result({ definition: 'SELECT id, name FROM customers WHERE active = 1', check_option: 'NONE', is_updatable: 'YES', security: 'DEFINER', definer: 'report_reader@localhost', character_set: 'utf8mb4', collation: 'utf8mb4_general_ci' })
      else if (/^SHOW CREATE /.test(sql)) { const type = sql.match(/^SHOW CREATE (\w+)/)[1].toLowerCase(); value = result({ [`Create ${type}`]: type === 'view' ? 'CREATE VIEW `orders`.`active_customers` AS SELECT id, name FROM customers WHERE active = 1;' : `CREATE ${type.toUpperCase()} ${sql.split(/\s+/).slice(3).join(' ')}\nBEGIN\n  SELECT 1;\nEND` }) }
      else throw new Error(`Missing metadata fixture: ${sql}`)
      return { state: 'completed', results: [value] }
    }
  })
  await connect(page); await openNavigation(page)
  const connection = page.locator('[data-connection=dev]')
  const disclosure = connection.locator('[data-expand-connection]')
  if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
  const database = connection.locator('.nav-tree-row').filter({ has: page.locator('[data-object=orders]') }).first()
  await expect(database).toBeVisible()
  if (await database.locator('[data-toggle]').getAttribute('aria-expanded') !== 'true') await database.locator('[data-toggle]').click()
  return connection
}

async function readObject(page, name, structure = false) {
  const button = page.locator(`[data-object="${name}"]`)
  await expect(button).toBeVisible()
  if (structure) { const row = button.locator('..'); await row.hover(); await row.locator('[data-open-object][data-view=structure]').click() }
  else await button.dblclick()
  if (await page.locator('[data-read-definition]').isVisible()) await page.locator('[data-read-definition]').click()
  await expect(page.locator('.wb-object-details')).toBeVisible()
}

const nonMetadataExecutions = page => page.evaluate(() => window.__calls.filter(call => call[0] === 'execute' && !call[1].sessionKey.startsWith('db-nav:')))

test('MySQL native object groups load lazily and opening definitions never calls a routine or executes a trigger', async ({ page }) => {
  await metadataFixture(page)
  expect(await page.evaluate(() => window.__calls.filter(call => call[0] === 'execute'))).toEqual([])
  const objects = [['存储过程', 'reconcile_orders', true], ['函数', 'customer_total', true], ['触发器', 'audit_order_change', false], ['事件', 'nightly_summary', false]]
  for (const [group, name, callable] of objects) {
    await page.getByRole('button', { name: `展开 ${group}`, exact: true }).click()
    await readObject(page, name)
    await expect(page.locator('.wb-object-definition')).toContainText('CREATE')
    await expect(page.locator('.wb-object-context [data-data]')).toBeHidden()
    await expect(page.locator('.wb-object-context [data-create-table]')).toBeHidden()
    await expect(page.locator('[data-invocation]')).toHaveCount(callable ? 1 : 0)
    expect(await nonMetadataExecutions(page)).toEqual([])
  }
  const metadataCalls = await page.evaluate(() => window.__calls.filter(call => call[0] === 'execute').map(call => call[1]))
  expect(metadataCalls.find(call => /ROUTINE_NAME AS name/.test(call.sql)).params).toEqual(['orders', 'PROCEDURE'])
  expect(metadataCalls.filter(call => call.sessionKey.startsWith('db-nav:object:')).every(call => !/^CALL\b/i.test(call.sql))).toBe(true)
  const readSessions = await page.evaluate(() => window.__calls.filter(call => call[0] === 'open' && call[1].sessionKey.startsWith('db-nav:object:')).map(call => call[1]))
  expect(readSessions.length).toBeGreaterThanOrEqual(4)
  expect(readSessions.every(call => call.config.readOnly === true)).toBe(true)
  await readObject(page, 'reconcile_orders')
  await page.mouse.move(900, 75)
  await expect(page.locator('#local-toast')).toHaveCSS('opacity', '0')
  await page.screenshot({ path: 'test-results-db/database-procedure-details.png' })
})

test('routine templates preserve IN OUT INOUT directions and remain entirely commented without execution', async ({ page }) => {
  await metadataFixture(page)
  await page.getByRole('button', { name: '展开 存储过程', exact: true }).click()
  await readObject(page, 'reconcile_orders')
  await expect(page.locator('.wb-object-details')).toContainText('INOUT')
  await page.locator('[data-invocation]').click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
  const source = await page.evaluate(async () => { const { monaco } = await import(performance.getEntriesByType('resource').find(entry => /\/assets\/app\/monaco-[^/]+\.js$/.test(entry.name)).name); return monaco.editor.getEditors()[0].getValue() })
  expect(source).toContain('-- CALL `orders`.`reconcile_orders`(')
  expect(source).toContain('/* OUT p_total */')
  expect(source).toContain('/* INOUT p_cursor */')
  expect(source.split('\n').every(line => line.startsWith('--'))).toBe(true)
  expect(await nonMetadataExecutions(page)).toEqual([])
})

test('views show native attributes and definition while remaining read-only without table design', async ({ page }) => {
  await metadataFixture(page)
  await readObject(page, 'active_customers', true)
  await expect(page.locator('.wb-object-details')).toContainText('服务器可更新标记')
  await expect(page.locator('.wb-object-details')).toContainText('YES')
  await expect(page.locator('.wb-object-details')).toContainText('按只读方式浏览')
  await expect(page.locator('[data-create-table]')).toBeHidden()
  await expect(page.locator('[data-design]')).toHaveCount(0)
  await page.locator('[data-definition] [data-browse]').click()
  await expect(page.locator('.grid-viewport')).toContainText('阿尔法')
  await expect(page.locator('[data-sel=commit]')).toBeHidden()
  await expect(page.locator('#results')).toContainText('只读')
  await page.locator('.grid-viewport [data-r="0"][data-c="1"]').dblclick()
  await expect(page.locator('.cell-editor')).toBeHidden()
  expect(await nonMetadataExecutions(page)).toEqual([])
})
