import { esc, options, uid } from './formMarkup.js'
import { bindColumnOrder } from './columnOrder.js'
import { scopeMatches } from '@db/sql-intelligence/providers/catalogContext.js'

/** Structured field selection, with manual names available for offline configuration. */
export function mountColumnSetEditor(root, context) {
  let selectedId = ''
  let catalog = null
  let loadGeneration = 0
  let destroyed = false
  let importing = false
  let queryMessage = ''
  const current = () => context.getDraft().columnSets.find(item => item.id === selectedId)
  const scope = () => current()?.scope || context.getScope()
  const selectedTable = () => {
    const matches = catalog?.tables?.filter(table => table.name === scope().table && scopeMatches(scope(), scope(), table)) || []
    return matches.length === 1 ? matches[0] : null
  }
  const commit = () => context.changed()

  function render() {
    const entries = context.getDraft().columnSets
    if (!entries.some(item => item.id === selectedId)) selectedId = entries[0]?.id || ''
    const item = current()
    root.innerHTML = `<div class="sql-section-heading"><h3>常用字段组</h3><div class="sql-inline-actions">${context.getQueryColumnSet ? `<button class="btn" data-import-query-set ${importing ? 'disabled' : ''}>从当前 SQL 新建</button>` : ''}<button class="btn" data-new-set>新建字段组</button></div></div><p class="muted">拖动字段左侧手柄调整顺序，或聚焦手柄后使用方向键。离线时可手工输入字段。</p><p class="muted" data-query-set-state role="status">${esc(queryMessage)}</p><div class="sql-item-layout"><div class="sql-item-list" role="list" aria-label="字段组">${entries.map(entry => `<button class="sql-item ${entry.id === selectedId ? 'active' : ''}" data-select-set="${esc(entry.id)}" role="listitem"><strong>${esc(entry.label || entry.id)}</strong><small>${esc(entry.scope?.table || '未选表')} · ${entry.columns?.length || 0} 个字段</small></button>`).join('') || '<p class="muted">尚未配置常用字段</p>'}</div><div class="sql-item-editor">${item ? editorMarkup(item) : '<p class="sql-empty">选择一张表，保存常用查询字段，下次补全时即可使用。</p>'}</div></div>`
  }

  function editorMarkup(item) {
    const connections = context.getConnections()
    const columns = selectedTable()?.columns || []
    const selected = item.columns || []
    return `<div class="sql-form-grid"><label>名称<input data-set-field="label" value="${esc(item.label)}"></label><label>连接<select data-set-scope="connectionId">${options([['', '所有连接'], ...connections.map(connection => [connection.id, connection.name || connection.id])], item.scope?.connectionId)}</select></label><label>数据库<input data-set-scope="database" value="${esc(item.scope?.database)}"></label><label>Schema<input data-set-scope="schema" value="${esc(item.scope?.schema)}"></label><label>表<input data-set-scope="table" list="sql-config-table-names" value="${esc(item.scope?.table)}"><datalist id="sql-config-table-names">${(catalog?.tables || []).map(table => `<option value="${esc(table.name)}">${esc(table.schema ? `${table.schema}.${table.name}` : table.name)}</option>`).join('')}</datalist></label><label>生成顺序<select data-set-field="order">${options([['configured', '字段组顺序'], ['schema', '表结构顺序']], item.order)}</select></label></div><div class="sql-inline-actions"><button class="btn" data-load-columns>读取表结构</button><button class="btn" data-remove-set>删除字段组</button></div><p class="muted" data-column-state>结构读取使用独立的只读会话。</p><div class="sql-column-picker">${columnPickerMarkup(columns, selected)}</div><ol class="sql-column-order">${selected.map((name, index) => `<li data-column-order-row="${index}"><button class="btn icon sql-column-drag" data-drag-column="${index}" aria-label="调整 ${esc(name)} 顺序" title="拖动或使用方向键调整字段顺序">⠿</button><span>${esc(name)}</span><button class="btn icon" data-move-column="${index}:-1" aria-label="上移 ${esc(name)}" ${index === 0 ? 'disabled' : ''}>↑</button><button class="btn icon" data-move-column="${index}:1" aria-label="下移 ${esc(name)}" ${index === selected.length - 1 ? 'disabled' : ''}>↓</button><button class="btn icon" data-remove-column="${index}" aria-label="移除 ${esc(name)}">×</button></li>`).join('')}</ol><label>字段名（逗号或换行分隔）<textarea rows="3" data-manual-columns spellcheck="false">${esc(selected.join(', '))}</textarea></label>`
  }

  async function load(explicit = false) {
    const request = ++loadGeneration
    // Namespace defaults belong to the selected connection. Merging the active
    // editor scope here would leak its database into a different connection.
    const target = { ...scope(), connectionId: scope().connectionId || context.getScope().connectionId }
    try {
      const note = root.querySelector('[data-column-state]')
      if (note) note.textContent = explicit ? '正在读取表结构…' : '正在读取缓存…'
      const next = explicit && context.ensureCatalog ? await context.ensureCatalog(target, { table: target.table, schema: target.schema }) : await context.getCatalog?.(target)
      if (destroyed || request !== loadGeneration) return
      catalog = next || null
      const state = root.querySelector('[data-column-state]')
      const columns = selectedTable()?.columns || []
      // Metadata may arrive during typing. Update only the catalog, never replace
      // the text inputs and lose a not-yet-blurred field draft or its selection.
      const picker = root.querySelector('.sql-column-picker')
      if (picker) picker.innerHTML = columnPickerMarkup(columns, current()?.columns || [])
      const names = root.querySelector('#sql-config-table-names')
      if (names) names.innerHTML = (catalog?.tables || []).map(table => `<option value="${esc(table.name)}">${esc(table.schema ? `${table.schema}.${table.name}` : table.name)}</option>`).join('')
      const missing = columns.length ? (current()?.columns || []).filter(name => !columns.some(column => column.name === name)) : []
      if (state) state.textContent = missing.length ? `以下字段不在当前表结构中：${missing.join('、')}。修正后才会提供该字段组建议。` : columns.length ? `已读取 ${columns.length} 个字段` : '没有可用字段。确认连接、数据库和表名，或手工输入字段。'
    } catch (error) {
      if (destroyed || request !== loadGeneration) return
      const note = root.querySelector('[data-column-state]')
      if (note) note.textContent = `读取失败：${error.message || error}`
    }
  }

  async function importQuery() {
    if (importing) return
    importing = true; queryMessage = '正在确认当前查询字段…'; render()
    try {
      const selection = await context.getQueryColumnSet()
      if (destroyed) return
      const item = { id: uid('fields'), label: `${selection.table} 查询字段`, scope: selection.scope, columns: selection.columns, order: 'configured' }
      context.getDraft().columnSets.push(item); selectedId = item.id; catalog = null
      queryMessage = `已提取 ${item.columns.length} 个字段，保存设置后可用于补全。`
      render(); commit(); void load()
    } catch (error) { if (!destroyed) { queryMessage = error.message || String(error); render() } }
    finally { importing = false; if (!destroyed) root.querySelector('[data-import-query-set]').disabled = false }
  }

  function moveColumn(index, next) {
    const item = current()
    if (!item || index < 0 || next < 0 || index >= item.columns.length || next >= item.columns.length) return
    const [name] = item.columns.splice(index, 1); item.columns.splice(next, 0, name)
    render(); root.querySelector(`[data-drag-column="${next}"]`)?.focus(); commit()
  }

  function click(event) {
    const target = event.target.closest('button')
    if (!target) return
    if (target.hasAttribute('data-import-query-set')) { void importQuery(); return }
    if (target.hasAttribute('data-new-set')) {
      const activeScope = context.getScope()
      const item = { id: uid('fields'), label: '常用字段', scope: Object.fromEntries(['connectionId', 'database', 'schema'].filter(key => activeScope[key]).map(key => [key, activeScope[key]])), columns: [], order: 'configured' }
      context.getDraft().columnSets.push(item); selectedId = item.id; render(); commit(); void load(); return
    }
    if (target.dataset.selectSet) { selectedId = target.dataset.selectSet; catalog = null; render(); void load(); return }
    const item = current()
    if (!item) return
    if (target.hasAttribute('data-load-columns')) { void load(true); return }
    if (target.hasAttribute('data-remove-set')) { context.getDraft().columnSets = context.getDraft().columnSets.filter(entry => entry.id !== item.id); render(); commit(); return }
    if (target.dataset.moveColumn) {
      const [index, direction] = target.dataset.moveColumn.split(':').map(Number)
      const next = index + direction
      if (next < 0 || next >= item.columns.length) return
      ;[item.columns[index], item.columns[next]] = [item.columns[next], item.columns[index]]
      render(); root.querySelector(`[data-move-column="${next}:${direction}"]`)?.focus(); commit(); return
    }
    if (target.hasAttribute('data-remove-column')) { item.columns.splice(Number(target.dataset.removeColumn), 1); render(); commit() }
  }

  function change(event) {
    const item = current()
    if (!item) return
    const target = event.target
    if (target.dataset.setField) item[target.dataset.setField] = target.value
    if (target.dataset.setScope) {
      const key = target.dataset.setScope
      item.scope ||= {}
      if (target.value) item.scope[key] = target.value
      else delete item.scope[key]
      loadGeneration++; catalog = null
      // Refresh the cached structure after each complete scope change, never connect implicitly.
      void load()
    }
    if (target.dataset.toggleColumn) {
      item.columns = target.checked ? [...new Set([...item.columns, target.dataset.toggleColumn])] : item.columns.filter(name => name !== target.dataset.toggleColumn)
      render()
    }
    if (target.hasAttribute('data-manual-columns')) { item.columns = [...new Set(target.value.split(/[,\n]/).map(name => name.trim()).filter(Boolean))]; render() }
    commit()
  }
  function input(event) {
    const item = current(), target = event.target
    if (!item) return
    if (target.hasAttribute('data-manual-columns')) item.columns = [...new Set(target.value.split(/[,\n]/).map(name => name.trim()).filter(Boolean))]
    else if (target.dataset.setField) item[target.dataset.setField] = target.value
    else if (target.dataset.setScope) {
      item.scope ||= {}
      if (target.value) item.scope[target.dataset.setScope] = target.value
      else delete item.scope[target.dataset.setScope]
      loadGeneration++
    } else return
    commit()
  }
  const releaseOrder = bindColumnOrder(root, { getColumns: () => current()?.columns || [], move: moveColumn })
  root.addEventListener('click', click)
  root.addEventListener('change', change)
  root.addEventListener('input', input)
  render(); void load()
  return { refresh: render, destroy() { destroyed = true; releaseOrder(); loadGeneration++; root.removeEventListener('click', click); root.removeEventListener('change', change); root.removeEventListener('input', input) } }
}

function columnPickerMarkup(columns, selected) {
  return columns.length ? columns.map(column => `<label><input type="checkbox" data-toggle-column="${esc(column.name)}" ${selected.includes(column.name) ? 'checked' : ''}><span title="${esc([column.name, column.comment, column.type].filter(Boolean).join(' · '))}">${esc(column.name)}<small>${esc(column.comment || column.type || '')}</small></span></label>`).join('') : '<span class="muted">暂无缓存字段，可读取表结构或在下方输入。</span>'
}
