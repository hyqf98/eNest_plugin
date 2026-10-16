import { esc, options, scopeLabel } from './formMarkup.js'
import { resolveConfig, validateConfig } from '@db/sql-intelligence/configuration/index.js'

export const SAMPLE_CATALOG = Object.freeze({ dialect: 'mysql', databases: ['demo'], schemas: [], tables: [
  { name: 'customers', database: 'demo', type: 'table', columns: [{ name: 'id', type: 'bigint', pk: true, comment: '客户编号' }, { name: 'name', type: 'varchar', comment: '姓名' }, { name: 'mobile', type: 'varchar', comment: '手机号' }, { name: 'status', type: 'int', comment: '状态' }, { name: 'created_at', type: 'datetime', comment: '创建时间' }] },
  { name: 'orders', database: 'demo', type: 'table', columns: [{ name: 'id', type: 'bigint', pk: true }, { name: 'customer_id', type: 'bigint', comment: '客户编号' }, { name: 'amount', type: 'decimal', comment: '订单金额' }], foreignKeys: [{ name: 'orders_customer_fk', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'] }] }
] })

/** Same completion callback as the editor; never calls query execution. */
export function mountCompletionPlayground(root, context) {
  let generation = 0
  let timer = null
  let destroyed = false
  let lastItems = []
  let lastText = ''
  const activeScope = context.getScope()
  root.innerHTML = `<div class="sql-section-heading"><h3>实时试验</h3><span class="muted">仅生成文本，不执行 SQL</span></div><div class="sql-form-grid"><label>元数据来源<select data-preview-connection>${options([['sample', '内置样例 · customers / orders'], ...context.getConnections().map(connection => [connection.id, connection.name || connection.id])], 'sample')}</select></label><label>方言<select data-preview-dialect>${options(['mysql', 'postgres', 'sqlite', 'sqlserver', 'oracle', 'duckdb', 'clickhouse'], activeScope.dialectId || 'mysql')}</select></label></div><label>SQL（用 | 指定光标位置）<textarea rows="5" data-preview-sql spellcheck="false">SELECT c.| FROM customers c</textarea></label><div class="sql-inline-actions"><button class="btn" data-preview-run>刷新建议</button><button class="btn" data-preview-read>读取所选连接元数据</button></div><p class="muted" data-preview-scope></p><div class="sql-preview-results" data-preview-results aria-live="polite"></div><pre class="sql-edit-preview" data-edit-preview hidden></pre><details><summary>有效配置来源</summary><dl class="sql-config-sources" data-config-sources></dl></details>`
  const source = root.querySelector('[data-preview-connection]')
  const dialect = root.querySelector('[data-preview-dialect]')
  const sql = root.querySelector('[data-preview-sql]')
  const results = root.querySelector('[data-preview-results]')
  const getScope = () => {
    const language = { dialectId: dialect.value, dialect: dialect.value }
    if (source.value === 'sample') return { ...language, database: 'demo' }
    const selected = context.getConnections().find(connection => connection.id === source.value)
    const active = context.getScope()
    const same = active.connectionId === source.value
    // Preview requests contain identifiers only, never connection credentials.
    return {
      ...language, connectionId: source.value,
      database: same ? active.database : selected?.database,
      schema: same ? active.schema : selected?.schema
    }
  }

  async function refresh(read = false) {
    const request = ++generation
    const scope = getScope()
    const config = context.getDraft()
    const issues = validateConfig(config)
    if (issues.length) { results.textContent = `先修正配置：${issues[0].path} ${issues[0].message}`; return }
    root.querySelector('[data-preview-scope]').textContent = `预览作用域：${source.value === 'sample' ? '内置样例' : scopeLabel(scope)} · ${dialect.value}`
    const effective = resolveConfig(config, scope)
    root.querySelector('[data-config-sources]').innerHTML = Object.entries(effective._sources).filter(([key]) => key.startsWith('behavior.') || key.startsWith('diagnostics.')).map(([key, name]) => `<dt>${esc(key)}</dt><dd>${esc(name)}</dd>`).join('')
    results.textContent = read ? '正在读取元数据…' : '正在生成建议…'
    try {
      const catalog = source.value === 'sample' ? SAMPLE_CATALOG : (read && context.ensureCatalog ? await context.ensureCatalog(scope, {}) : await context.getCatalog?.(scope))
      if (destroyed || request !== generation) return
      const marker = sql.value.indexOf('|')
      const text = marker < 0 ? sql.value : sql.value.slice(0, marker) + sql.value.slice(marker + 1)
      const cursorOffset = marker < 0 ? sql.selectionStart : marker
      const response = await context.previewCompletion?.({ text, cursorOffset, scope, config, catalog })
      if (destroyed || request !== generation) return
      lastText = text
      lastItems = Array.isArray(response) ? response : response?.items || response?.suggestions || response?.candidates || []
      results.innerHTML = lastItems.length ? `<div class="sql-preview-candidates">${lastItems.slice(0, 20).map((item, index) => `<button data-preview-item="${index}"><strong>${esc(typeof item.label === 'object' ? item.label.label : item.label)}</strong><span>${esc(item.detail || item.reason || item.kind || '')}</span></button>`).join('')}</div>` : '<p class="muted">当前没有匹配的建议。可尝试 SELECT c.| FROM customers c。</p>'
      const diagnostics = response?.diagnostics || []
      if (diagnostics.length) results.insertAdjacentHTML('beforeend', `<ul class="sql-preview-diagnostics">${diagnostics.map(item => `<li>${esc(item.message || item.label || '')}</li>`).join('')}</ul>`)
      root.querySelector('[data-edit-preview]').hidden = true
    } catch (error) {
      if (!destroyed && request === generation) results.textContent = `预览失败：${error.message || error}`
    }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(() => { void refresh() }, 100) }
  function click(event) {
    if (event.target.closest('[data-preview-run]')) { void refresh(); return }
    if (event.target.closest('[data-preview-read]')) { void refresh(true); return }
    const button = event.target.closest('[data-preview-item]')
    if (!button) return
    const item = lastItems[Number(button.dataset.previewItem)]
    const preview = root.querySelector('[data-edit-preview]')
    preview.textContent = previewText(lastText, item)
    preview.hidden = false
  }
  root.addEventListener('click', click)
  root.addEventListener('input', schedule)
  root.addEventListener('change', schedule)
  void refresh()
  return { refresh: schedule, destroy() { destroyed = true; generation++; clearTimeout(timer); root.removeEventListener('click', click); root.removeEventListener('input', schedule); root.removeEventListener('change', schedule) } }
}

function previewText(text, item) {
  const primary = item?.editPlan?.primaryEdit || (Number.isInteger(item?.editPlan?.from) ? item.editPlan : null)
  const edits = primary ? [primary, ...(item.editPlan.additionalEdits || [])] : item?.range ? [{ start: item.range.from, end: item.range.to, text: item.insertText || '' }] : null
  if (!Array.isArray(edits)) return item?.insertText || item?.text || ''
  let result = text
  for (const edit of [...edits].sort((a, b) => (b.start ?? b.from ?? 0) - (a.start ?? a.from ?? 0))) {
    const from = edit.start ?? edit.from ?? edit.range?.from
    const to = edit.end ?? edit.to ?? edit.range?.to
    if (!Number.isInteger(from) || !Number.isInteger(to)) return item.insertText || primary.text || primary.newText || ''
    result = result.slice(0, from) + (edit.text ?? edit.newText ?? '') + result.slice(to)
  }
  return result
}
