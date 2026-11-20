/**
 * confirm.mjs — 写操作判定 + 参数摘要（A2UI 版只保留纯逻辑）
 * 判定规则（满足其一即为写操作）：
 *   query 首关键词 ∈ insert/update/delete/replace/merge/truncate/create/drop/alter/grant/revoke
 *   applyChanges / importCsv(run:true) / connection.delete
 * 确认卡 UI 已迁 A2UI SqlConfirm surface（a2ui/catalog.mjs），由 app 侧生成；
 * isWriteCall/summarizeArgs 供 agent 循环与工具行渲染共用。
 */

const WRITE_KEYWORDS = /^(insert|update|delete|replace|merge|truncate|create|drop|alter|grant|revoke)\b/i

/** 是否为写操作（需要用户确认） */
export function isWriteCall(name, args) {
  const id = String(name || '')
  if (id === 'db_connection_delete') return true
  if (id === 'db_apply_changes') return true
  if (id === 'db_import_csv' && args?.run === true) return true
  if (id === 'db_query') {
    const sql = String(args?.sql || '').trim()
    const first = sql.slice(0, sql.indexOf(' ') > 0 ? sql.indexOf(' ') : sql.length)
    return WRITE_KEYWORDS.test(first)
  }
  return false
}

/** 参数一句话摘要（确认卡与工具树行共用） */
export function summarizeArgs(name, args) {
  const id = String(name || '')
  const a = args && typeof args === 'object' ? args : {}
  const short = (v, n = 80) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n)
  if (id === 'db_query') return short(a.sql, 100)
  if (id === 'db_apply_changes') {
    const changes = Array.isArray(a.changes) ? a.changes : []
    const counts = {}
    for (const c of changes) counts[c?.type] = (counts[c?.type] || 0) + 1
    const parts = Object.entries(counts).map(([type, n]) => `${type} ${n}`)
    const table = changes[0]?.table?.table || changes[0]?.table || ''
    return `${table ? `${table} · ` : ''}${parts.join(' / ') || '无变更'}`
  }
  if (id === 'db_import_csv') {
    const table = typeof a.table === 'string' ? a.table : a.table?.table || ''
    return `${table} · ${a.run === true ? '执行导入' : '预览'}`
  }
  if (id === 'db_schema_tree' || id === 'db_schema_describe' || id === 'db_schema_ddl') {
    return short(a.table || a.filter || a.parent || '', 60)
  }
  if (id === 'db_connection_delete') return short(a.connectionId, 60)
  if (id === 'db_connection_open' || id === 'db_connection_test') return short(a.connectionId, 60)
  try { return short(JSON.stringify(a), 60) } catch { return '' }
}
