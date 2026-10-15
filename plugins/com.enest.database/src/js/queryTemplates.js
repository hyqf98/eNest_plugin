const mysql = /^(mysql|mariadb|tidb|oceanbase|doris|starrocks|tdengine)$/
export function qualifiedName(driver, { database, schema, table }) {
  const wrap = (value) => driver === 'mssql' ? `[${String(value).replaceAll(']', ']]')}]` : mysql.test(driver) ? '`' + String(value).replaceAll('`', '``') + '`' : '"' + String(value).replaceAll('"', '""') + '"'
  const parts = mysql.test(driver) ? [database, table] : driver === 'mssql' ? [database, schema || 'dbo', table] : [schema, table]
  return parts.filter(Boolean).map(wrap).join('.')
}
export function objectQuery(driver, table, count = false) {
  if (driver === 'mongodb') return JSON.stringify({ collection: table.table, operation: count ? 'count' : 'find', filter: {} }, null, 2)
  if (driver === 'redis') return JSON.stringify([count ? 'EXISTS' : 'TYPE', table.table])
  if (['elasticsearch', 'opensearch'].includes(driver)) return JSON.stringify({ index: table.table, query: { match_all: {} }, size: 200 }, null, 2)
  if (driver === 'influxdb') return `from(bucket: ${JSON.stringify(table.database || '')})\n  |> range(start: -1h)\n  |> filter(fn: (r) => r._measurement == ${JSON.stringify(table.table)})\n  |> ${count ? 'count()' : 'limit(n: 200)'}`
  if (driver === 'neo4j') return `MATCH (n:\`${table.table.replaceAll('`', '``')}\`) RETURN ${count ? 'count(n)' : 'n LIMIT 200'}`
  const name = qualifiedName(driver, table)
  if (count) return `SELECT COUNT(*) AS count FROM ${name};`
  return driver === 'mssql' ? `SELECT TOP (200) * FROM ${name};` : driver === 'oracle' ? `SELECT * FROM ${name} FETCH FIRST 200 ROWS ONLY;` : `SELECT * FROM ${name} LIMIT 200;`
}
export function queryTemplates(driver, connection = {}) {
  if (driver === 'mongodb') return [
    { label: '筛选文档', text: JSON.stringify({ collection: 'collection_name', operation: 'find', filter: {}, projection: {}, sort: { _id: -1 } }, null, 2) },
    { label: '聚合管道', text: JSON.stringify({ collection: 'collection_name', operation: 'aggregate', pipeline: [{ $match: {} }, { $group: { _id: '$category', count: { $sum: 1 } } }] }, null, 2) },
    { label: '统计文档', text: JSON.stringify({ collection: 'collection_name', operation: 'count', filter: {} }, null, 2) }
  ]
  if (driver === 'redis') return [{ label: '扫描键（有界分页）', text: '["SCAN", "0", "MATCH", "*", "COUNT", "100"]' }, { label: '读取字符串', text: '["GET", "key_name"]' }, { label: '读取 Hash', text: '["HGETALL", "key_name"]' }, { label: '读取列表', text: '["LRANGE", "key_name", "0", "99"]' }, { label: '键类型与到期时间', text: '["TTL", "key_name"]' }]
  if (driver === 'neo4j') return [{ label: '读取节点与关系', text: 'MATCH (n)-[r]->(m)\nRETURN n, r, m\nLIMIT 100;' }]
  if (['elasticsearch', 'opensearch'].includes(driver)) return [{ label: '搜索文档', text: JSON.stringify({ index: 'index_name', query: { match_all: {} }, size: 100 }, null, 2) }]
  if (driver === 'influxdb') return [{ label: '最近一小时与窗口聚合', text: `from(bucket: ${JSON.stringify(connection.options?.bucket || connection.database || 'bucket_name')})\n  |> range(start: -1h)\n  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)\n  |> yield(name: "mean")` }]
  if (driver === 'tdengine') return [{ label: '超级表按时间窗口聚合', text: 'SELECT _wstart, AVG(value)\nFROM stable_name\nWHERE ts >= NOW - 1h\nINTERVAL(1m);' }, { label: '查看超级表', text: 'SHOW STABLES;' }, { label: '查看子表与标签', text: 'SHOW TAGS FROM table_name;' }]
  return [{ label: '查询表数据', text: objectQuery(driver, { table: 'table_name', database: connection.database }) }, { label: '分组统计', text: 'SELECT category, COUNT(*) AS total\nFROM table_name\nGROUP BY category\nORDER BY total DESC;' }, { label: '关联查询', text: 'SELECT a.id, b.name\nFROM table_a AS a\nLEFT JOIN table_b AS b ON b.id = a.related_id\nWHERE a.id = 1;' }]
}

/** Review-only routine templates. Every line is commented; nothing can run as generated. */
export function objectInvocationTemplate(driver, object, parameters) {
  const type = String(object.type || object.objectType || '').toLowerCase()
  if (!['procedure', 'function'].includes(type)) return '-- 此对象不是可调用的存储过程或函数；请查看其定义与属性。'
  if (!['mysql', 'mariadb'].includes(driver)) return `-- 当前 ${String(driver).replace(/[\r\n]/g, ' ')} 驱动未提供此类对象的调用模板。`
  if (!Array.isArray(parameters) || object.parametersKnown === false) return '-- 参数元数据未完整读取，无法安全生成调用模板。请先检查查看权限。'
  if (!(object.name || object.objectName || object.table)) return '-- 对象名称缺失，请从连接树重新打开后再生成调用模板。'
  const name = qualifiedName(driver, { database: object.database, schema: object.schema, table: object.name || object.objectName || object.table })
  const args = parameters.filter(parameter => Number(parameter.position) !== 0).sort((a, b) => Number(a.position) - Number(b.position))
  const lines = ['仅生成调用草稿，不会自动执行。', '过程和函数可能写入数据或产生外部副作用；先检查定义、参数、连接和事务。', '填写所有 <…> 占位符并逐行取消注释后，再由你决定执行。', '']
  const bindings = args.map((parameter, index) => {
    const direction = String(parameter.mode || 'IN').toUpperCase(), label = String(parameter.name || `参数${index + 1}`).replace(/[\r\n]/g, ' '), dataType = String(parameter.dataType || '未知类型').replace(/[\r\n]/g, ' ')
    if (type === 'procedure' && ['OUT', 'INOUT'].includes(direction)) {
      const variable = `@enest_arg_${index + 1}`
      lines.push(`SET ${variable} = ${direction === 'OUT' ? 'NULL' : `<${label}: ${dataType}>`};  /* ${direction} ${label} */`)
      return variable
    }
    return `<${label}: ${dataType}>`
  })
  lines.push(type === 'procedure' ? `CALL ${name}(${bindings.join(', ')});` : `SELECT ${name}(${bindings.join(', ')}) AS result;`)
  const outputs = args.flatMap((parameter, index) => ['OUT', 'INOUT'].includes(String(parameter.mode).toUpperCase()) ? [`@enest_arg_${index + 1}`] : [])
  if (type === 'procedure' && outputs.length) lines.push(`SELECT ${outputs.join(', ')};`)
  return lines.flatMap(line => line.split(/\r?\n/)).map(line => `-- ${line}`).join('\n')
}
