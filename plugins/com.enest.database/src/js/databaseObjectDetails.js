/** Object metadata stays in the plugin and uses the existing read-only query API. */
import { DbHost, toConnectionInput } from './api.js'
import { qualifiedName } from './queryTemplates.js'

const labels = { table: '表', view: '视图', materialized_view: '物化视图', procedure: '存储过程', function: '函数', trigger: '触发器', event: '事件', collection: '集合', measurement: '时序数据', supertable: '超级表', key: '键', other: '对象' }
const special = new Set(['procedure', 'function', 'trigger', 'event'])
const mysqlMetadataDrivers = new Set(['mysql', 'mariadb'])
const mysqlCompatibleDrivers = new Set(['mysql', 'mariadb', 'tidb', 'oceanbase', 'doris', 'starrocks'])
const queues = new Map()
let metadataId = 0

export function objectPolicy(value = 'other') {
  const type = String(value).toLowerCase().replaceAll(' ', '_')
  return { type, label: labels[type] || '对象', browse: !special.has(type) && type !== 'group' && type !== 'notice', design: type === 'table', special: special.has(type), template: ['procedure', 'function'].includes(type) }
}

/** One native database session accepts one operation at a time. */
export function serializeMetadata(sessionKey, operation) {
  const previous = queues.get(sessionKey) || Promise.resolve()
  const result = previous.catch(() => {}).then(operation)
  const settled = result.then(() => {}, () => {})
  queues.set(sessionKey, settled)
  settled.then(() => { if (queues.get(sessionKey) === settled) queues.delete(sessionKey) })
  return result
}

export function specialObjectReason(driver) {
  return mysqlMetadataDrivers.has(driver) ? '' : `当前 ${driver || '数据库'} 适配尚未提供存储过程、函数、触发器和事件元数据；不能按 MySQL 兼容协议推断这些能力。`
}

/** Group already discovered relations; special groups load only when expanded. */
export function groupDatabaseObjects(driver, nodes, scope = {}) {
  if (!mysqlCompatibleDrivers.has(driver)) return nodes
  const groups = []
  for (const [type, name] of [['table', '表'], ['view', '视图']]) {
    const children = nodes.filter(node => node.type === type)
    groups.push({ name, type: 'group', groupType: type, ...scope, defaultExpanded: children.length > 0, children })
  }
  for (const [type, name] of [['procedure', '存储过程'], ['function', '函数'], ['trigger', '触发器'], ['event', '事件']]) {
    const children = nodes.filter(node => node.type === type)
    groups.push({ name, type: 'group', groupType: type, ...scope, ...(children.length ? { children } : {}), unsupportedReason: specialObjectReason(driver) })
  }
  return [...groups, ...nodes.filter(node => !['table', 'view', ...special].includes(node.type))]
}

function records(value) {
  const result = Array.isArray(value) ? value[0] : value
  if (!result || !Array.isArray(result.rows)) throw new Error('数据库未返回可识别的元数据结果')
  if (!result.columns?.length && result.rows.length) throw new Error('元数据结果缺少列定义')
  return { rows: result.rows.map(row => Array.isArray(row) ? Object.fromEntries(result.columns.map((column, index) => [String(column.name).toLowerCase(), row[index]])) : row), truncated: !!result.truncated }
}
async function query(sessionKey, sql, params, surface) {
  return records(await DbHost.execute({ sessionKey, sql, ...(params ? { params } : {}), maxRows: 1001, timeoutMs: 8000, surface }))
}
const objectName = object => String(object.name || object.objectName || object.table || '')
const permissionReason = error => /denied|privilege|permission|access|not authorized/i.test(error?.message || '') ? `权限不足：${error.message}` : String(error?.message || error)

export async function listDatabaseObjects({ driver, sessionKey, database, type, surface = 'shell' }) {
  if (!mysqlMetadataDrivers.has(driver)) throw new Error(specialObjectReason(driver))
  if (!database) throw new Error('请先选择数据库，再读取此类对象')
  let sql, params
  if (type === 'procedure' || type === 'function') {
    sql = 'SELECT ROUTINE_NAME AS name, ROUTINE_COMMENT AS comment FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ? ORDER BY ROUTINE_NAME LIMIT 1001'
    params = [database, type.toUpperCase()]
  } else if (type === 'trigger') {
    sql = 'SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS related_table FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME LIMIT 1001'; params = [database]
  } else if (type === 'event') {
    sql = 'SELECT EVENT_NAME AS name, STATUS AS status FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME LIMIT 1001'; params = [database]
  } else throw new Error('此对象分组不支持独立元数据查询')
  const result = await query(sessionKey, sql, params, surface)
  const nodes = result.rows.slice(0, 1000).map(row => ({ name: String(row.name), type, database, expandable: false, comment: row.comment || row.related_table || row.status || '' }))
  if (result.truncated || result.rows.length > 1000) nodes.push({ name: '仅显示前 1000 个对象', type: 'notice', expandable: false, comment: '请在查询文档中按名称筛选系统目录' })
  return nodes
}

async function readMysqlObject(sessionKey, object, surface) {
  const type = objectPolicy(object.type).type, database = object.database, name = objectName(object)
  if (!database) throw new Error('对象缺少数据库名称，请从连接树重新打开')
  let sql, properties
  const params = [database, name]
  if (['procedure', 'function'].includes(type)) {
    sql = 'SELECT ROUTINE_DEFINITION AS definition, DATA_TYPE AS return_type, IS_DETERMINISTIC AS deterministic, SQL_DATA_ACCESS AS data_access, SECURITY_TYPE AS security, DEFINER AS definer, CREATED AS created, LAST_ALTERED AS altered, ROUTINE_COMMENT AS comment FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ?'
    params.push(type.toUpperCase())
    properties = [['return_type', '返回类型'], ['deterministic', '确定性'], ['data_access', '数据访问'], ['security', '安全上下文'], ['definer', '定义者'], ['created', '创建时间'], ['altered', '修改时间'], ['comment', '备注']]
  } else if (type === 'trigger') {
    sql = 'SELECT ACTION_STATEMENT AS definition, EVENT_OBJECT_TABLE AS related_table, EVENT_MANIPULATION AS manipulation, ACTION_TIMING AS timing, ACTION_ORIENTATION AS orientation, DEFINER AS definer, SQL_MODE AS sql_mode FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = ?'
    properties = [['related_table', '关联表'], ['manipulation', '触发事件'], ['timing', '触发时机'], ['orientation', '执行粒度'], ['definer', '定义者'], ['sql_mode', 'SQL 模式']]
  } else if (type === 'event') {
    sql = 'SELECT EVENT_DEFINITION AS definition, EVENT_TYPE AS event_type, EXECUTE_AT AS execute_at, INTERVAL_VALUE AS interval_value, INTERVAL_FIELD AS interval_field, STARTS AS starts, ENDS AS ends, STATUS AS status, ON_COMPLETION AS on_completion, TIME_ZONE AS time_zone, DEFINER AS definer, LAST_EXECUTED AS last_executed, EVENT_COMMENT AS comment FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? AND EVENT_NAME = ?'
    properties = [['event_type', '计划类型'], ['execute_at', '执行时间'], ['interval_value', '间隔'], ['interval_field', '间隔单位'], ['starts', '开始时间'], ['ends', '结束时间'], ['status', '状态'], ['on_completion', '完成后保留'], ['time_zone', '时区'], ['definer', '定义者'], ['last_executed', '上次执行'], ['comment', '备注']]
  } else if (type === 'view') {
    sql = 'SELECT VIEW_DEFINITION AS definition, CHECK_OPTION AS check_option, IS_UPDATABLE AS is_updatable, SECURITY_TYPE AS security, DEFINER AS definer, CHARACTER_SET_CLIENT AS character_set, COLLATION_CONNECTION AS collation FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?'
    properties = [['check_option', '检查选项'], ['is_updatable', '服务器可更新标记'], ['security', '安全上下文'], ['definer', '定义者'], ['character_set', '字符集'], ['collation', '排序规则']]
  } else throw new Error('此对象类型没有 MySQL 特殊详情')
  const found = (await query(sessionKey, sql, params, surface)).rows[0]
  if (!found) return { state: 'unavailable', reason: '服务器未返回此对象。对象可能已删除，或当前账号没有查看权限。', parameters: [], columns: [], properties: [], definition: '' }
  const detail = { state: 'available', properties: properties.filter(([key]) => type !== 'procedure' || key !== 'return_type').map(([key, label]) => [label, found[key]]), parameters: [], columns: [], definition: found.definition || '', definitionLabel: type === 'view' ? '视图查询（服务器原文）' : '定义主体（服务器原文）', reasons: [] }
  if (['procedure', 'function'].includes(type)) {
    try {
      const values = await query(sessionKey, 'SELECT ORDINAL_POSITION AS position, PARAMETER_MODE AS mode, PARAMETER_NAME AS name, DTD_IDENTIFIER AS data_type FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ROUTINE_TYPE = ? ORDER BY ORDINAL_POSITION', [database, name, type.toUpperCase()], surface)
      detail.parameters = values.rows.map(row => ({ position: Number(row.position), name: row.name || (Number(row.position) === 0 ? '返回值' : ''), mode: row.mode || (Number(row.position) === 0 ? 'RETURN' : 'IN'), dataType: row.data_type || '未返回' }))
      detail.parametersKnown = !values.truncated
      if (values.truncated) detail.reasons.push('参数列表超出读取上限，不生成调用模板。')
    } catch (error) { detail.parametersKnown = false; detail.reasons.push(`参数未读取：${permissionReason(error)}`) }
  }
  if (type === 'view') {
    try { const columns = await DbHost.schema.describe({ sessionKey, database, table: name }); detail.columns = columns.columns || [] } catch (error) { detail.reasons.push(`字段未读取：${permissionReason(error)}`) }
    detail.reasons.push('视图数据在此工作台中按只读方式浏览，不能使用表结构设计。')
  }
  // SHOW identifiers cannot be parameters; each identifier is dialect-quoted.
  try {
    const definition = await query(sessionKey, `SHOW CREATE ${type.toUpperCase()} ${qualifiedName('mysql', { database, table: name })}`, undefined, surface)
    const row = definition.rows[0] || {}
    const value = row[`create ${type}`] || row['sql original statement']
    if (typeof value === 'string' && value.trim()) { detail.definition = value; detail.definitionLabel = '创建定义（服务器原文）' }
  } catch (error) { detail.reasons.push(`完整创建定义未读取：${permissionReason(error)}`) }
  if (!detail.definition) detail.reasons.push('服务器未公开定义，当前账号可能缺少 SHOW VIEW / SHOW ROUTINE 等查看权限。')
  detail.reason = detail.reasons.join('\n')
  return detail
}

/** A detail request never borrows a SQL console, including on the Quick surface. */
export async function readDatabaseObject(connection, object, { surface = 'shell', isCurrent = () => true } = {}) {
  const policy = objectPolicy(object.type), base = { type: policy.type, label: policy.label, name: objectName(object), parameters: [], columns: [], properties: [], definition: '' }
  if (policy.special && !mysqlMetadataDrivers.has(connection?.driver)) return { ...base, state: 'unsupported', reason: specialObjectReason(connection?.driver) }
  if (!base.name || !connection) return { ...base, state: 'unavailable', reason: '对象或连接已不存在，请从连接树重新打开。' }
  const config = toConnectionInput(connection, { database: object.database || connection.database, readOnly: true, createIfMissing: false })
  config.options = { ...config.options, schema: object.schema, readOnly: true, createIfMissing: false }
  let sessionKey
  try {
    if (!isCurrent()) throw new Error('对象读取上下文已改变')
    const preferred = `db-nav:object:${Date.now().toString(36)}:${++metadataId}:${surface}`
    const opened = await DbHost.open({ config, sessionKey: preferred }); sessionKey = opened?.sessionKey || opened?.key || preferred
    if (!isCurrent()) throw new Error('对象读取上下文已改变')
    const detail = await serializeMetadata(sessionKey, async () => {
      if (!isCurrent()) throw new Error('对象读取上下文已改变')
      if (mysqlMetadataDrivers.has(connection.driver) && (policy.special || policy.type === 'view')) return readMysqlObject(sessionKey, { ...object, database: object.database || connection.database }, surface)
      const req = { sessionKey, database: object.database || connection.database, schema: object.schema, table: base.name }
      const value = await DbHost.schema.describe(req)
      let definition = value.ddl || '', reason = ''
      try { if (!definition) { const ddl = await DbHost.schema.ddl(req); definition = typeof ddl === 'string' ? ddl : ddl?.ddl || '' } } catch (error) { reason = `定义未读取：${permissionReason(error)}` }
      return { state: 'available', describe: value, columns: value.columns || [], properties: [['对象类型', policy.label], ['数据访问', policy.type === 'view' || policy.type === 'materialized_view' ? '只读浏览' : '按连接权限']], definition, definitionLabel: '定义（服务器原文）', reason }
    })
    if (!isCurrent()) throw new Error('对象读取上下文已改变')
    return { ...base, ...detail }
  } catch (error) { return { ...base, state: /denied|privilege|permission/i.test(error.message) ? 'permission-denied' : 'error', reason: permissionReason(error) } }
  finally { if (sessionKey) await DbHost.close(sessionKey).catch(() => {}) }
}

const escape = value => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
function detailTable(headings, rows, empty) {
  return rows.length ? `<div class="wb-table-wrap"><table class="wb-table"><thead><tr>${headings.map(label => `<th>${escape(label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<p class="muted">${escape(empty)}</p>`
}
export function renderDatabaseObjectDetails(detail) {
  if (detail.state !== 'available') return `<div class="wb-empty"><strong>${detail.state === 'permission-denied' ? '没有查看权限' : detail.state === 'unsupported' ? '暂不支持此对象' : '无法读取对象'}</strong><p>${escape(detail.reason)}</p></div>`
  return `<section class="wb-object-details"><h3>属性</h3>${detailTable(['属性', '值'], detail.properties || [], '服务器没有返回属性。')}${['procedure', 'function'].includes(detail.type) ? `<h3>参数${detail.parametersKnown === false ? '（未完整读取）' : ''}</h3>${detailTable(['顺序', '名称', '方向', '类型'], (detail.parameters || []).map(parameter => [parameter.position, parameter.name, parameter.mode, parameter.dataType]), detail.parametersKnown === false ? '无法确认参数，请先检查权限。' : '无参数。')}` : ''}${detail.columns?.length ? `<h3>字段</h3>${detailTable(['名称', '类型', '可空', '备注'], detail.columns.map(column => [column.name, column.dataType || column.type, column.nullable === undefined ? '未知' : column.nullable ? '是' : '否', column.comment || '']), '')}` : ''}<h3>${escape(detail.definitionLabel || '定义')}</h3>${detail.definition ? `<pre class="wb-object-definition" tabindex="0" aria-label="${escape(detail.label)}定义"><code>${escape(detail.definition)}</code></pre>` : '<p class="muted">定义不可见。</p>'}${detail.reason ? `<p class="muted wb-object-reason">${escape(detail.reason).replaceAll('\n', '<br>')}</p>` : ''}</section>`
}
