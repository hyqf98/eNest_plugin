import test from 'node:test'
import assert from 'node:assert/strict'

let calls = [], queryHandler, schemaHandler, openHook, active = 0, maximum = 0
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = rows => ({ columns: Object.keys(rows[0] || {}).map(name => ({ name })), rows: rows.map(row => Object.values(row)), rowCount: rows.length })
globalThis.window = { enest: {
  storage: { get: async () => null, set: async () => true }, ui: { toast: async () => true },
  db: {
    open: async request => { calls.push(['open', request]); await openHook?.(); return { sessionKey: request.sessionKey } },
    close: async sessionKey => { calls.push(['close', sessionKey]); return true },
    execute: async request => { calls.push(['execute', request]); active++; maximum = Math.max(maximum, active); try { return await queryHandler(request) } finally { active-- } },
    schema: {
      tree: async request => { calls.push(['tree', request]); active++; maximum = Math.max(maximum, active); try { return await schemaHandler(request) } finally { active-- } },
      describe: async request => { calls.push(['describe', request]); active++; maximum = Math.max(maximum, active); try { await sleep(5); return { columns: [{ name: 'id', dataType: 'INT', comment: '主键' }] } } finally { active-- } },
      ddl: async () => 'CREATE VIEW report AS SELECT 1;'
    }
  }
} }
const { objectPolicy, groupDatabaseObjects, serializeMetadata, listDatabaseObjects, readDatabaseObject, renderDatabaseObjectDetails } = await import('../../plugins/database/src/js/databaseObjectDetails.js')
const { objectInvocationTemplate } = await import('../../plugins/database/src/js/queryTemplates.js')
const { SidePanel } = await import('../../plugins/database/src/js/schemaTree.js')
const { state } = await import('../../plugins/database/src/js/store.js')
const connection = { id: 'dev', name: '开发', driver: 'mysql', database: 'orders', readOnly: false }
function reset() { calls = []; active = 0; maximum = 0; openHook = null; queryHandler = async () => result([]); schemaHandler = async () => []; state.connections = [connection]; state.runtime.sessionKeys.clear(); state.runtime.consoleSessionKeys.clear() }

function navigator() {
  const panel = Object.create(SidePanel.prototype)
  Object.assign(panel, { root: { closest: () => ({ dataset: { surface: 'shell' } }) }, h: {}, disposed: false, instanceId: 'test', treeData: new Map(), nodes: new Map(), errors: new Map(), requests: new Map(), generations: new Map(), metadataSessions: new Map(), openingSessions: new Map(), redisScans: new Map(), expanded: new Set(), initializedGroups: new Set(), render() {}, _selectNode() {} })
  return panel
}

test('relations and executable objects have distinct policies and lazy MySQL groups', () => {
  assert.equal(objectPolicy('view').browse, true); assert.equal(objectPolicy('view').design, false)
  for (const type of ['procedure', 'function', 'trigger', 'event']) { assert.equal(objectPolicy(type).browse, false); assert.equal(objectPolicy(type).design, false) }
  assert.equal(objectPolicy('table').design, true)
  const groups = groupDatabaseObjects('mysql', [{ type: 'table', name: 'orders' }, { type: 'view', name: 'totals' }], { database: 'orders' })
  assert.deepEqual(groups.map(group => group.groupType), ['table', 'view', 'procedure', 'function', 'trigger', 'event'])
  assert.equal(groups[0].children[0].name, 'orders'); assert.equal(groups[1].children[0].name, 'totals'); assert.equal(groups[2].children, undefined)
  assert.match(groupDatabaseObjects('tidb', [])[2].unsupportedReason, /不能按 MySQL 兼容协议推断/)
})

test('routine discovery parameterizes database and type, and bounds object count', async () => {
  reset(); queryHandler = async () => result(Array.from({ length: 1001 }, (_, index) => ({ name: `routine_${index}`, comment: '说明' })))
  const database = "app'; DROP DATABASE x; --"
  const nodes = await listDatabaseObjects({ driver: 'mysql', sessionKey: 'metadata', database, type: 'procedure' })
  const request = calls[0][1]
  assert.deepEqual(request.params, [database, 'PROCEDURE']); assert.equal(request.sql.includes(database), false); assert.match(request.sql, /LIMIT 1001$/)
  assert.equal(nodes.length, 1001); assert.equal(nodes.at(-1).type, 'notice'); assert.equal(nodes[0].expandable, false)
})

test('routine details use their own read-only Quick session, parameterize names, escape definitions and close', async () => {
  reset()
  const database = "db'quote", name = 'proc`quoted'
  queryHandler = async request => request.sql.includes('information_schema.ROUTINES') ? result([{ definition: 'BEGIN SELECT 1; END', return_type: '', deterministic: 'NO', data_access: 'MODIFIES SQL DATA' }]) : request.sql.includes('information_schema.PARAMETERS') ? result([{ position: 1, mode: 'IN', name: 'p_id', data_type: 'INT' }, { position: 2, mode: 'OUT', name: 'p_result', data_type: 'TEXT' }]) : result([{ 'Create Procedure': 'CREATE PROCEDURE `<script>`() BEGIN SELECT 1; END' }])
  const detail = await readDatabaseObject(connection, { name, type: 'procedure', database }, { surface: 'quick' })
  const opened = calls.find(([kind]) => kind === 'open')[1], requests = calls.filter(([kind]) => kind === 'execute').map(([, request]) => request)
  assert.equal(opened.config.readOnly, true); assert.equal(opened.config.options.readOnly, true); assert.match(opened.sessionKey, /^db-nav:object:.*:quick$/)
  assert.deepEqual(requests[0].params, [database, name, 'PROCEDURE']); assert.deepEqual(requests[1].params, [database, name, 'PROCEDURE'])
  assert.equal(requests[2].sql, "SHOW CREATE PROCEDURE `db'quote`.`proc``quoted`")
  assert.ok(requests.every(request => request.surface === 'quick' && /^(SELECT|SHOW) /.test(request.sql)))
  assert.equal(detail.parametersKnown, true); assert.equal(detail.parameters[1].mode, 'OUT'); assert.equal(detail.definitionLabel, '创建定义（服务器原文）')
  const html = renderDatabaseObjectDetails(detail); assert.match(html, /&lt;script&gt;/); assert.equal(html.includes('<script>'), false)
  assert.equal(calls.at(-1)[0], 'close'); assert.equal(calls.at(-1)[1], opened.sessionKey)
})

test('missing routine privileges keep an explicit partial reason and suppress invocation drafts', async () => {
  reset(); queryHandler = async request => { if (request.sql.includes('information_schema.ROUTINES')) return result([{ definition: null }]); throw new Error('Access denied for SHOW ROUTINE') }
  const detail = await readDatabaseObject(connection, { name: 'restricted', type: 'function', database: 'orders' })
  assert.equal(detail.parametersKnown, false); assert.match(detail.reason, /参数未读取/); assert.match(detail.reason, /权限不足/); assert.equal(detail.definition, '')
  assert.equal(objectInvocationTemplate('mysql', { name: 'restricted', type: 'function', parametersKnown: detail.parametersKnown }, detail.parameters).includes('SELECT'), false)
  assert.equal(calls.at(-1)[0], 'close')
})

test('view details expose properties and columns without manufacturing edit permission', async () => {
  reset(); queryHandler = async request => request.sql.startsWith('SHOW') ? result([{ 'Create View': 'CREATE VIEW `orders`.`report` AS SELECT 1 AS id' }]) : result([{ definition: 'select 1', is_updatable: 'YES', check_option: 'NONE' }])
  const detail = await readDatabaseObject(connection, { name: 'report', type: 'view', database: 'orders' })
  assert.equal(detail.columns[0].comment, '主键'); assert.equal(detail.properties.find(([label]) => label === '服务器可更新标记')[1], 'YES'); assert.match(detail.reason, /只读方式浏览/)
  assert.equal(objectPolicy(detail.type).design, false); assert.equal(calls.at(-1)[0], 'close')
})

test('unsupported engines and invalidated detail requests never execute or leak sessions', async () => {
  reset()
  const unsupported = await readDatabaseObject({ ...connection, driver: 'tidb' }, { name: 'routine', type: 'procedure' })
  assert.equal(unsupported.state, 'unsupported'); assert.equal(calls.length, 0)
  let valid = true; openHook = async () => { valid = false }
  const stale = await readDatabaseObject(connection, { name: 'routine', type: 'procedure' }, { isCurrent: () => valid })
  assert.equal(stale.state, 'error'); assert.deepEqual(calls.map(([kind]) => kind), ['open', 'close'])
})

test('invocation drafts preserve parameter directions and quote names while commenting every line', () => {
  const sql = objectInvocationTemplate('mysql', { database: 'db`name', name: 'routine`name', type: 'procedure' }, [{ position: 1, name: 'input', mode: 'IN', dataType: 'INT' }, { position: 2, name: 'out', mode: 'OUT', dataType: 'TEXT' }, { position: 3, name: 'both', mode: 'INOUT', dataType: 'INT' }])
  assert.ok(sql.split('\n').every(line => line.startsWith('-- '))); assert.match(sql, /CALL `db``name`.`routine``name`/); assert.match(sql, /SET @enest_arg_2 = NULL/); assert.match(sql, /SET @enest_arg_3 = <both: INT>/)
  const fn = objectInvocationTemplate('mariadb', { name: 'f', type: 'function' }, [{ position: 0, mode: 'RETURN', dataType: 'INT' }, { position: 1, name: 'x', mode: 'IN', dataType: 'INT' }])
  assert.match(fn, /SELECT `f`\(<x: INT>\)/); assert.equal(fn.includes('RETURN'), false)
})

test('metadata queue serializes same-session tasks and continues after failures', async () => {
  reset(); const order = []
  const first = serializeMetadata('one', async () => { order.push('first'); await sleep(8); throw new Error('fixture failure') })
  const second = serializeMetadata('one', async () => { order.push('second'); return 'done' })
  await assert.rejects(first, /fixture failure/); assert.equal(await second, 'done'); assert.deepEqual(order, ['first', 'second'])
})

test('tree groups remain lazy and same-scope discovery plus result descriptions share a read-only queue', async () => {
  reset()
  schemaHandler = async request => [{ name: 'orders', type: 'database', database: 'orders', children: [{ name: 'customers', type: 'table' }, { name: 'summary', type: 'view' }] }]
  queryHandler = async request => { await sleep(8); return result([{ name: request.params[1] === 'PROCEDURE' ? 'rebuild_report' : 'calc_total', comment: '说明' }]) }
  const panel = navigator(); await panel.loadNode('conn:dev')
  assert.equal(calls.filter(([kind]) => kind === 'execute').length, 0)
  const groups = [...panel.nodes.values()].filter(node => node.type === 'group')
  assert.equal(groups.length, 6); assert.ok(panel.expanded.has(groups.find(node => node.data.groupType === 'table').key))
  const procedure = groups.find(node => node.data.groupType === 'procedure'), fn = groups.find(node => node.data.groupType === 'function')
  await Promise.all([panel.loadNode(procedure.key), panel.loadNode(fn.key), panel.describeForResult(connection, { database: 'orders', table: 'customers' })])
  assert.equal(maximum, 1, 'same metadata transport must never overlap work')
  assert.equal(calls.filter(([kind]) => kind === 'open').length, 1)
  assert.equal(calls.find(([kind]) => kind === 'open')[1].config.readOnly, true)
  const node = [...panel.nodes.values()].find(node => node.type === 'procedure'), picks = []
  panel.h.onOpenObject = (...args) => picks.push(args)
  await panel._openObject(node.key, 'data'); assert.equal(picks[0][2], 'structure')
  const html = panel._renderChildren(procedure.key, connection, '', 3)
  assert.equal(html.includes('data-view="data"'), false); assert.match(html, /data-view="structure"/)
  await panel.dispose(); assert.equal(calls.at(-1)[0], 'close')
})
