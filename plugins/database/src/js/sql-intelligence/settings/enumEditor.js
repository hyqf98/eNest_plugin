import { getDialect } from '@db/sql-intelligence/dialects/registry.js'
import { clone, esc, options, uid } from './formMarkup.js'
import { enumValueDraft, parseEnumValue } from './ruleModel.js'
import { handleScopeInput, ruleScopeLabel, scopeMarkup } from './scopeEditor.js'

const valueTypes = [['string', '文本'], ['number', '数值'], ['boolean', '布尔值'], ['null', 'NULL']]

/** Keep invalid cell text in the form while retaining the last valid JSON values. */
export function mountEnumEditor(root, context) {
  let selectedId = ''
  const drafts = new Map()
  const items = () => context.getDraft().enums
  const current = () => items().find(item => item.id === selectedId)
  function rows(item) {
    if (!drafts.has(item.id)) drafts.set(item.id, (item.values || []).map(enumValueDraft))
    return drafts.get(item.id)
  }
  function render() {
    if (!current()) selectedId = items()[0]?.id || ''
    const item = current()
    root.innerHTML = `<div class="sql-section-heading"><h3>字段静态枚举</h3><button class="btn" data-new-enum>新建枚举</button></div><p class="muted">在字段等号右侧提示预设值。保留文本、数值、布尔值和 NULL 类型，由当前数据库方言生成字面量。</p><div class="sql-item-layout"><div class="sql-item-list" data-enum-list aria-label="字段静态枚举"></div><div class="sql-item-editor">${item ? editor(item) : '<p class="sql-empty">例如为 status 配置 pending、active，为 enabled 配置 true、false。</p>'}</div></div>`
    renderList()
    if (item) renderRows()
  }
  function renderList() {
    root.querySelector('[data-enum-list]').innerHTML = items().map(item => `<button class="sql-item ${selectedId === item.id ? 'active' : ''}" data-select-enum="${esc(item.id)}" aria-pressed="${selectedId === item.id}"><strong>${esc(item.column || '未指定字段')}</strong><small>${item.disabled ? '已停用 · ' : ''}${esc(ruleScopeLabel(item.scope))}</small></button>`).join('')
  }
  function editor(item) {
    return `<div class="sql-inline-actions"><label class="sql-setting-check"><input type="checkbox" data-enum-enabled ${item.disabled ? '' : 'checked'}>启用枚举</label><button class="btn" data-copy-enum>复制枚举</button><button class="btn" data-delete-enum>删除枚举</button></div><label>字段名称<input data-enum-column value="${esc(item.column)}" placeholder="status" maxlength="256"></label>${scopeMarkup(item.scope, context.getConnections(), { open: true })}<div class="sql-section-heading sql-rule-values-heading"><h4>候选值</h4><button class="btn" data-add-enum-value>添加值</button></div><div class="sql-rule-values" data-enum-values></div><p class="sql-config-issues" data-enum-issues role="status"></p><p class="muted" data-enum-preview></p>`
  }
  function renderRows() {
    const item = current(), values = rows(item)
    root.querySelector('[data-enum-values]').innerHTML = values.length ? values.map((row, index) => `<div class="sql-rule-value-row"><label><span class="sql-rule-small-label">类型</span><select data-enum-type="${index}" aria-label="第 ${index + 1} 个值类型">${options(valueTypes, row.type)}</select></label><label><span class="sql-rule-small-label">值 ${index + 1}</span>${row.type === 'boolean' ? `<select data-enum-value="${index}" aria-label="第 ${index + 1} 个值">${options([['true', 'true'], ['false', 'false']], row.text)}</select>` : `<input data-enum-value="${index}" aria-label="第 ${index + 1} 个值" value="${esc(row.type === 'null' ? 'NULL' : row.text)}" ${row.type === 'null' ? 'disabled' : ''} ${row.type === 'number' ? 'inputmode="decimal"' : ''} maxlength="2000" spellcheck="false">`}</label><button class="btn" data-remove-enum-value="${index}" aria-label="删除第 ${index + 1} 个值">删除</button></div>`).join('') : '<p class="sql-empty">尚无候选值。添加值后可在等号右侧使用。</p>'
    root.querySelector('[data-add-enum-value]').disabled = values.length >= 500
    renderStatus()
  }
  function rowIssues(item) {
    return rows(item).flatMap((row, index) => {
      const parsed = parseEnumValue(row)
      return parsed.error ? [{ path: `枚举 ${item.column || item.id} / 值 ${index + 1}`, message: parsed.error }] : []
    })
  }
  function renderStatus() {
    const item = current()
    root.querySelector('[data-enum-issues]').textContent = rowIssues(item).map(issue => `${issue.path}：${issue.message}`).join('\n')
    const dialect = getDialect(item.scope?.dialectId || context.getScope().dialectId || 'mysql')
    const valid = rows(item).map(parseEnumValue).filter(parsed => !parsed.error)
    root.querySelector('[data-enum-preview]').textContent = `字面量预览（${dialect.id}）：${valid.slice(0, 10).map(parsed => dialect.literal(parsed.value)).join(' · ') || '尚无有效值'}${valid.length > 10 ? ` · 共 ${valid.length} 项` : ''}`
  }
  function commitRows() {
    const item = current()
    if (!rowIssues(item).length) item.values = rows(item).map(row => parseEnumValue(row).value)
  }
  function input(event) {
    const item = current(), target = event.target
    if (!item) return
    let edited = handleScopeInput(event, root, item)
    if (target.hasAttribute('data-enum-column')) { item.column = target.value; edited = true }
    if (target.hasAttribute('data-enum-enabled')) { item.disabled = !target.checked; edited = true }
    if (target.hasAttribute('data-enum-type')) {
      const index = Number(target.dataset.enumType), previous = rows(item)[index]
      rows(item)[index] = { type: target.value, text: target.value === 'boolean' ? (previous.text === 'false' ? 'false' : 'true') : target.value === 'null' ? '' : previous.text }
      commitRows(); renderRows(); root.querySelector(`[data-enum-type="${index}"]`)?.focus(); edited = true
    }
    if (target.hasAttribute('data-enum-value')) { rows(item)[Number(target.dataset.enumValue)].text = target.value; commitRows(); edited = true }
    if (edited) { renderList(); renderStatus(); context.changed() }
  }
  function click(event) {
    const target = event.target.closest('button')
    if (!target) return
    if (target.dataset.selectEnum) { selectedId = target.dataset.selectEnum; render(); return }
    if (target.hasAttribute('data-new-enum')) {
      const active = context.getScope()
      const item = { id: uid('enum'), column: '', values: [], scope: active.connectionId ? { connectionId: active.connectionId } : {} }
      items().push(item); selectedId = item.id
    } else if (target.hasAttribute('data-copy-enum') && current()) {
      const item = { ...clone(current()), id: uid('enum') }
      drafts.set(item.id, clone(rows(current()))); items().push(item); selectedId = item.id
    } else if (target.hasAttribute('data-delete-enum') && current()) { drafts.delete(selectedId); context.getDraft().enums = items().filter(item => item.id !== selectedId) }
    else if (target.hasAttribute('data-add-enum-value') && current()) {
      if (rows(current()).length >= 500) return
      rows(current()).push({ type: 'string', text: '' }); commitRows(); renderRows(); context.changed()
      root.querySelector(`[data-enum-value="${rows(current()).length - 1}"]`)?.focus(); return
    } else if (target.hasAttribute('data-remove-enum-value') && current()) {
      const index = Number(target.dataset.removeEnumValue)
      rows(current()).splice(index, 1); commitRows(); renderRows(); context.changed()
      ;(root.querySelector(`[data-remove-enum-value="${Math.min(index, rows(current()).length - 1)}"]`) || root.querySelector('[data-add-enum-value]'))?.focus(); return
    } else return
    render(); context.changed(); root.querySelector('[data-enum-column]')?.focus()
  }
  root.addEventListener('input', input); root.addEventListener('click', click)
  render()
  return { getIssues: () => items().flatMap(rowIssues), destroy() { root.removeEventListener('input', input); root.removeEventListener('click', click); drafts.clear() } }
}
