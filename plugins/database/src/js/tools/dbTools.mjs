/**
 * dbTools — MCP 16 个工具的业务体（自 mcp.mjs 原样提取）
 * execTool(id, args, ctx) 为纯调度函数：ctx = { sessions, suffix }
 *   sessions：Map<connectionId, sessionKey>（调用方持有：MCP 用 ::mcp、AI 用 ::ai，互不抢占）
 *   suffix：connection.open 生成的会话键后缀
 * 返回 { text, structured }（structured 可省略）；业务失败直接 throw，由调用方包装。
 * 运行时禁止任何交互：不弹选择器/对话框，错误原样透传给上层转述。
 */

import { DbHost, Vault, hostCall, toConnectionInput, sessionKeyOf } from '../api.js'
import { state, getConnection, saveConnection, removeConnection, upsertConnection, uid } from '../store.js'
import { parseTableRef } from '../importExport.js'

/** 与 plugin.json contributes.mcpTools 逐一对应，顺序同声明 */
export const DB_TOOL_IDS = [
  'connections.list',
  'connection.open',
  'connection.close',
  'sessions.list',
  'connection.test',
  'query',
  'explain',
  'cancel',
  'applyChanges',
  'importCsv',
  'schema.tree',
  'schema.describe',
  'schema.ddl',
  'dialects.list',
  'connection.save',
  'connection.delete'
]

const fail = (message) => { throw new Error(message) }

function need(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') fail(`缺少必填参数：${label}`)
  return value
}

function connectionOf(id) {
  const conn = getConnection(need(id, 'connectionId'))
  if (!conn) fail(`连接 ${id} 不存在，请先调用 connections.list 查看已保存连接`)
  return conn
}

/** 显式 sessionKey 优先；否则用 connection.open 缓存的会话 */
function sessionKeyFor(args, sessions) {
  if (args.sessionKey) return String(args.sessionKey)
  const key = sessions.get(need(args.connectionId, 'connectionId（或显式 sessionKey）'))
  if (!key) fail(`连接 ${args.connectionId} 尚未打开，请先调用 connection.open`)
  return key
}

/** "schema.table" / "db.schema.table" 字符串或对象 → TableRef */
function tableRefOf(value) {
  if (typeof value === 'string') {
    const ref = parseTableRef(need(value, 'table'))
    if (!ref.table) fail('table 需要形如 "table"、"schema.table" 或 "db.schema.table"')
    return ref
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { database: value.database, schema: value.schema, table: need(value.table, 'table.table') }
  }
  return fail('table 需要是字符串或 { database, schema, table } 对象')
}

/** 密钥只允许 vault 引用；密码/Token/本地路径键一律拒绝（与界面表单校验一致） */
const FORBIDDEN_OPTION_KEY = /password|token|secret|api.?key|^(file|filePath|sqlitePath)$/i

function listableConnection(c) {
  return {
    id: c.id,
    name: c.name,
    driver: c.driver,
    host: c.host,
    port: c.port,
    database: c.database,
    username: c.username,
    env: c.env,
    readOnly: !!c.readOnly,
    favorite: !!c.favorite
  }
}

const CELL_LIMIT = 2000
const ROW_CAP = 400

function trimCell(value) {
  if (typeof value === 'string') return value.length > CELL_LIMIT ? `${value.slice(0, CELL_LIMIT)}…(${value.length} 字符)` : value
  if (typeof value === 'bigint') return value.toString()
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value)
      if (text && text.length > CELL_LIMIT) return `${text.slice(0, CELL_LIMIT)}…`
    } catch {
      return '[object]'
    }
  }
  return value === undefined ? null : value
}

/** 结果瘦身：行数封顶、超长单元格截断，保证 structuredContent 适配 1MiB 限制 */
function trimResult(result) {
  if (!result || typeof result !== 'object') return result
  const rows = Array.isArray(result.rows) ? result.rows : []
  const cut = rows.length > ROW_CAP
  return {
    columns: result.columns,
    rows: (cut ? rows.slice(0, ROW_CAP) : rows).map((row) => (Array.isArray(row) ? row.map(trimCell) : trimCell(row))),
    rowCount: result.rowCount ?? rows.length,
    affectedRows: result.affectedRows,
    durationMs: result.durationMs,
    truncated: result.truncated === true || cut || undefined,
    messages: result.messages,
    error: result.error
  }
}

function scopeFields(args) {
  const out = {}
  if (args.database) out.database = args.database
  if (args.schema) out.schema = args.schema
  return out
}

/** 各工具业务体；返回 { text, structured }，失败 throw */
const RUNNERS = {
  'connections.list': async () => {
    const connections = state.connections.map(listableConnection)
    return { text: `共 ${connections.length} 个已保存连接`, structured: { connections } }
  },

  'connection.open': async (args, ctx) => {
    const conn = connectionOf(args.connectionId)
    const overrides = args.database ? { database: String(args.database) } : {}
    const preferred = `${sessionKeyOf(conn.id, overrides.database || conn.database)}${ctx.suffix}`
    const session = await hostCall('db.open', [{ config: toConnectionInput(conn, overrides), sessionKey: preferred }])
    const sessionKey = session?.sessionKey || session?.key || preferred
    ctx.sessions.set(conn.id, sessionKey)
    conn.lastConnectedAt = Date.now()
    upsertConnection(conn)
    return {
      text: `连接「${conn.name}」已打开（会话 ${sessionKey}），后续工具只需传 connectionId`,
      structured: {
        connectionId: conn.id,
        sessionKey,
        driver: session?.driver || conn.driver,
        database: session?.database ?? overrides.database ?? conn.database,
        readOnly: session?.readOnly ?? !!conn.readOnly,
        env: conn.env
      }
    }
  },

  'connection.close': async (args, ctx) => {
    const sessionKey = args.sessionKey
      ? String(args.sessionKey)
      : ctx.sessions.get(need(args.connectionId, 'connectionId（或显式 sessionKey）'))
    if (!sessionKey) fail('未找到打开的会话：请先 connection.open，或用 sessions.list 查看可用 sessionKey')
    await DbHost.close(sessionKey)
    for (const [id, key] of ctx.sessions) if (key === sessionKey) ctx.sessions.delete(id)
    return { text: `已关闭数据库会话 ${sessionKey}`, structured: { sessionKey, closed: true } }
  },

  'sessions.list': async () => {
    const sessions = await DbHost.listSessions()
    return { text: `共 ${Array.isArray(sessions) ? sessions.length : 0} 个活动数据库会话`, structured: { sessions: Array.isArray(sessions) ? sessions : [] } }
  },

  'connection.test': async (args) => {
    const conn = connectionOf(args.connectionId)
    const result = await hostCall('db.test', [toConnectionInput(conn)])
    const good = !!result?.ok
    return {
      text: good ? `连接成功 ${result.version || ''} ${result.message || ''}`.trim() : `连接失败：${result?.message || '未知错误'}`,
      structured: { connectionId: conn.id, ...(result && typeof result === 'object' ? result : { ok: false }) }
    }
  },

  query: async (args, ctx) => {
    const sql = need(args.sql, 'sql')
    const sessionKey = sessionKeyFor(args, ctx.sessions)
    const req = { sessionKey, sql: String(sql) }
    if (args.maxRows !== undefined) req.maxRows = args.maxRows
    if (args.timeoutMs !== undefined) req.timeoutMs = args.timeoutMs
    if (args.confirmed !== undefined) req.confirmed = args.confirmed === true
    Object.assign(req, scopeFields(args))
    const raw = await DbHost.execute(req)
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.results) ? raw.results : [raw])
    const results = list.map(trimResult)
    const first = results[0] || {}
    const parts = [`执行完成：${results.length} 个结果`]
    if (first.rowCount !== undefined) parts.push(`${first.rowCount} 行`)
    if (first.affectedRows !== undefined) parts.push(`影响 ${first.affectedRows} 行`)
    if (first.durationMs !== undefined) parts.push(`${first.durationMs} ms`)
    if (results.some((r) => r.truncated)) parts.push(`每结果已截断至 ${ROW_CAP} 行`)
    const transactionActive = list.at(-1)?.transactionActive
    return { text: parts.join(' · '), structured: { results, ...(transactionActive !== undefined ? { transactionActive: !!transactionActive } : {}) } }
  },

  explain: async (args, ctx) => {
    const sessionKey = sessionKeyFor(args, ctx.sessions)
    const result = trimResult(await DbHost.explain({ sessionKey, sql: String(need(args.sql, 'sql')) }))
    return { text: `执行计划：${result?.rowCount ?? 0} 行`, structured: { result } }
  },

  cancel: async (args, ctx) => {
    const sessionKey = sessionKeyFor(args, ctx.sessions)
    const cancelled = await DbHost.cancel({ sessionKey })
    return { text: cancelled === false ? '当前没有可取消的查询' : '已请求取消该会话上的运行中查询', structured: { sessionKey, cancelled: cancelled !== false } }
  },

  applyChanges: async (args, ctx) => {
    if (!Array.isArray(args.changes) || !args.changes.length) fail('changes 需要为非空数组')
    if (args.changes.length > 2000) fail('changes 一次最多 2000 条，请分批提交')
    const sessionKey = sessionKeyFor(args, ctx.sessions)
    const res = await DbHost.applyChanges({
      sessionKey,
      changes: args.changes,
      mode: args.mode === 'continue' ? 'continue' : 'stop-on-error',
      confirmed: args.confirmed === true
    })
    const items = (res?.results || []).map((item) => ({
      index: item.index,
      ok: !!item.ok,
      affected: item.affected,
      error: item.error ? String(item.error).slice(0, 300) : undefined
    }))
    const okCount = items.filter((item) => item.ok).length
    const parts = [`批量变更：成功 ${okCount} / 失败 ${items.length - okCount}`]
    if (res?.durationMs !== undefined) parts.push(`${res.durationMs} ms`)
    if (!res?.ok) parts.push('存在失败项（stop-on-error 模式整批回滚）')
    return { text: parts.join(' · '), structured: { ok: !!res?.ok, durationMs: res?.durationMs, results: items } }
  },

  importCsv: async (args, ctx) => {
    const csvText = String(need(args.csvText, 'csvText'))
    if (csvText.length > 512000) fail('csvText 过大（>512KB），请分批导入')
    const sessionKey = sessionKeyFor(args, ctx.sessions)
    const table = tableRefOf(args.table)
    const options = {}
    if (args.delimiter) options.delimiter = String(args.delimiter)
    if (args.hasHeader !== undefined) options.hasHeader = args.hasHeader !== false
    if (Array.isArray(args.columns)) options.columns = args.columns.map(String)
    if (args.conflict) options.conflict = String(args.conflict)
    const payload = { sessionKey, table, csvText, ...(Object.keys(options).length ? { options } : {}) }
    const preview = await DbHost.importPreview({ ...payload, options: { ...options, sampleRows: 20 } })
    const previewSummary = {
      columns: preview?.columns || [],
      sampleRows: (preview?.sampleRows || []).slice(0, 20),
      totalRowsEstimate: preview?.totalRowsEstimate,
      mappedColumns: preview?.mappedColumns || [],
      sqlPreview: (preview?.sqlPreview || []).slice(0, 5)
    }
    if (args.run !== true) {
      return {
        text: `预览完成：约 ${previewSummary.totalRowsEstimate ?? '?'} 行 · ${previewSummary.columns.length} 列 · 目标 ${table.table}。确认无误后带 run:true（生产/保护连接还需 confirmed:true）重新调用`,
        structured: { ran: false, table, preview: previewSummary }
      }
    }
    const result = await DbHost.importRun({ ...payload, confirmed: args.confirmed === true })
    const failed = result?.failed || 0
    const parts = [`导入完成：成功 ${result?.inserted ?? 0}${failed ? ` · 失败 ${failed}` : ''}`]
    if (result?.durationMs !== undefined) parts.push(`${result.durationMs} ms`)
    if (result?.errors?.length) parts.push(`首批错误：${result.errors[0]}`)
    return { text: parts.join(' · '), structured: { ran: true, table, preview: previewSummary, result } }
  },

  'schema.tree': async (args, ctx) => {
    const sessionKey = sessionKeyFor(args, ctx.sessions)
    const req = { sessionKey, ...scopeFields(args) }
    if (args.parent) req.parent = String(args.parent)
    if (args.table) req.table = String(args.table)
    if (args.filter) req.filter = String(args.filter)
    const nodes = await DbHost.schema.tree(req)
    const list = Array.isArray(nodes) ? nodes : []
    return { text: `返回 ${list.length} 个节点${args.filter ? `（filter: ${args.filter}）` : ''}`, structured: { nodes: list } }
  },

  'schema.describe': async (args, ctx) => {
    const sessionKey = sessionKeyFor(args, ctx.sessions)
    const detail = await DbHost.schema.describe({ sessionKey, ...scopeFields(args), table: String(need(args.table, 'table')) })
    const count = Array.isArray(detail?.columns) ? detail.columns.length : 0
    return { text: `表 ${args.table} 共 ${count} 列`, structured: { table: args.table, detail } }
  },

  'schema.ddl': async (args, ctx) => {
    const sessionKey = sessionKeyFor(args, ctx.sessions)
    const ddl = await DbHost.schema.ddl({ sessionKey, ...scopeFields(args), table: String(need(args.table, 'table')) })
    const text = typeof ddl === 'string' ? ddl : (ddl?.ddl || '')
    return { text: text ? `DDL 长度 ${text.length} 字符` : '驱动未返回 DDL', structured: { table: args.table, ddl: text.slice(0, 60000) } }
  },

  'dialects.list': async () => {
    const list = await DbHost.dialectsList()
    const dialects = (Array.isArray(list) ? list : []).map((d) => ({
      id: d.id,
      label: d.label || d.id,
      language: d.language,
      transport: d.transport
    }))
    return { text: `支持 ${dialects.length} 种数据库驱动`, structured: { dialects } }
  },

  'connection.save': async (args, ctx) => {
    const existing = args.id ? getConnection(String(args.id)) : null
    const conn = existing
      ? { ...existing }
      : { id: args.id ? String(args.id) : uid('conn'), name: '', driver: '', env: 'dev', options: {} }
    for (const key of ['name', 'driver', 'host', 'port', 'database', 'username', 'env', 'note', 'org', 'bucket', 'schema']) {
      if (args[key] !== undefined) conn[key] = args[key]
    }
    if (args.readOnly !== undefined) conn.readOnly = args.readOnly === true
    if (args.favorite !== undefined) conn.favorite = args.favorite === true
    if (args.secretRef !== undefined) conn.secretRef = args.secretRef ? String(args.secretRef) : undefined
    if (args.options && typeof args.options === 'object' && !Array.isArray(args.options)) {
      const bad = Object.keys(args.options).find((key) => FORBIDDEN_OPTION_KEY.test(key))
      if (bad) fail(`options.${bad} 不允许：密码/Token/本地文件路径请使用宿主授权字段`)
      conn.options = { ...(conn.options || {}), ...args.options }
    }
    if (!conn.name) fail('缺少必填参数：name')
    if (!conn.driver) fail('缺少必填参数：driver')
    if (['sqlite', 'duckdb'].includes(conn.driver) && !conn.fileHandleId && conn.database !== ':memory:') {
      fail('本地文件驱动（sqlite/duckdb）需要宿主授权的文件句柄，请在插件界面中创建该连接')
    }
    if (!['sqlite', 'duckdb'].includes(conn.driver) && !conn.host && !conn.options?.uri && !conn.options?.endpoint && !conn.options?.connectString) {
      fail('网络驱动需要 host 或 options.uri / options.endpoint / options.connectString')
    }
    if (existing) {
      if (state.sessions.some((s) => s.connectionId === existing.id && s.transactionActive)) fail('此连接仍有事务，请先提交或回滚后再修改配置')
      const openKey = ctx.sessions.get(existing.id)
      if (openKey) { await DbHost.close(openKey).catch(() => {}); ctx.sessions.delete(existing.id) }
    }
    const saved = await saveConnection(conn)
    return { text: existing ? `已更新连接「${saved.name}」(${saved.id})` : `已创建连接「${saved.name}」(${saved.id})`, structured: listableConnection(saved) }
  },

  'connection.delete': async (args, ctx) => {
    const conn = connectionOf(args.connectionId)
    if (state.sessions.some((s) => s.connectionId === conn.id && s.transactionActive)) fail('此连接仍有事务，请先提交或回滚')
    const openKey = ctx.sessions.get(conn.id)
    if (openKey) { await DbHost.close(openKey).catch(() => {}); ctx.sessions.delete(conn.id) }
    await removeConnection(conn.id)
    if (conn.secretRef) await Vault.remove(conn.secretRef).catch(() => { /* 宿主滞后时凭据保留，无碍 */ })
    return { text: `已删除连接「${conn.name}」(${conn.id})，数据库本身未改动`, structured: { id: conn.id, deleted: true } }
  }
}

/**
 * 统一入口：按工具 id 调度业务体。
 * @param {string} id DB_TOOL_IDS 之一
 * @param {object} args 工具参数
 * @param {{ sessions: Map, suffix: string }} ctx 会话映射与会话键后缀
 * @returns {Promise<{ text: string, structured?: object }>}
 */
export async function execTool(id, args, ctx) {
  const run = RUNNERS[id]
  if (!run) throw new Error(`未知工具：${id}`)
  if (!ctx?.sessions || !ctx?.suffix) throw new Error('execTool 需要提供会话上下文')
  return run(args || {}, ctx)
}
