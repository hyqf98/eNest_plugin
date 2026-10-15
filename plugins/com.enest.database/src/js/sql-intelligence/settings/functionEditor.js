import { clone, esc, uid } from './formMarkup.js'
import { dialectOptions, handleScopeInput, ruleScopeLabel, scopeMarkup } from './scopeEditor.js'

/** Custom function definitions are local completion data, never SQL execution. */
export function mountFunctionEditor(root, context) {
  let selectedId = ''
  const items = () => context.getDraft().functions
  const current = () => items().find(item => item.id === selectedId)
  function render() {
    if (!current()) selectedId = items()[0]?.id || ''
    const item = current()
    root.innerHTML = `<div class="sql-section-heading"><h3>自定义函数</h3><button class="btn" data-new-function>新建函数</button></div><p class="muted">为数据库已有的函数补充名称、参数和说明。接受候选后可按 Tab 填写参数；不会创建或执行函数。</p><div class="sql-item-layout"><div class="sql-item-list" data-function-list aria-label="自定义函数"></div><div class="sql-item-editor">${item ? editor(item) : '<p class="sql-empty">新建函数，为项目内常用函数提供参数提示。</p>'}</div></div>`
    renderList()
  }
  function renderList() {
    root.querySelector('[data-function-list]').innerHTML = items().map(item => `<button class="sql-item ${selectedId === item.id ? 'active' : ''}" data-select-function="${esc(item.id)}" aria-pressed="${selectedId === item.id}"><strong>${esc(item.name || '未命名函数')}</strong><small>${item.disabled ? '已停用 · ' : ''}${esc(ruleScopeLabel(item.scope))}</small></button>`).join('')
  }
  function editor(item) {
    const dialects = [...new Set([...dialectOptions().map(([id]) => id), ...(item.dialects || [])])]
    return `<div class="sql-inline-actions"><label class="sql-setting-check"><input type="checkbox" data-function-enabled ${item.disabled ? '' : 'checked'}>启用函数</label><button class="btn" data-copy-function>复制函数</button><button class="btn" data-delete-function>删除函数</button></div><div class="sql-form-grid"><label>函数名称<input data-function-field="name" value="${esc(item.name)}" placeholder="MASK_PHONE" maxlength="256"></label><label>函数签名<input data-function-field="signature" value="${esc(item.signature)}" placeholder="MASK_PHONE(phone, keep_digits)" maxlength="2000" spellcheck="false"></label></div><label>说明<textarea data-function-field="description" rows="3" maxlength="4000">${esc(item.description)}</textarea></label><details class="sql-rule-dialects"><summary>适用方言 · <span data-function-dialect-label>${esc(item.dialects?.length ? item.dialects.join('、') : '全部')}</span></summary><p class="muted">不勾选表示全部方言。产品方言分别匹配，例如 MySQL 与 MariaDB。</p><div class="sql-rule-checks">${dialects.map(id => `<label class="sql-setting-check"><input type="checkbox" data-function-dialect="${esc(id)}" ${item.dialects?.includes(id) ? 'checked' : ''}>${esc(id)}</label>`).join('')}</div></details>${scopeMarkup(item.scope, context.getConnections())}`
  }
  function input(event) {
    const item = current(), target = event.target
    if (!item) return
    let edited = handleScopeInput(event, root, item)
    if (target.dataset.functionField) { item[target.dataset.functionField] = target.value; edited = true }
    if (target.hasAttribute('data-function-enabled')) { item.disabled = !target.checked; edited = true }
    if (target.dataset.functionDialect) {
      const selected = new Set(item.dialects || [])
      if (target.checked) selected.add(target.dataset.functionDialect); else selected.delete(target.dataset.functionDialect)
      item.dialects = [...selected]
      root.querySelector('[data-function-dialect-label]').textContent = item.dialects.join('、') || '全部'
      edited = true
    }
    if (edited) { renderList(); context.changed() }
  }
  function click(event) {
    const target = event.target.closest('button')
    if (!target) return
    if (target.dataset.selectFunction) { selectedId = target.dataset.selectFunction; render(); return }
    if (target.hasAttribute('data-new-function')) {
      const item = { id: uid('function'), name: '', signature: '', description: '' }
      items().push(item); selectedId = item.id
    } else if (target.hasAttribute('data-copy-function') && current()) {
      const item = { ...clone(current()), id: uid('function'), name: `${current().name || '函数'}_COPY` }
      items().push(item); selectedId = item.id
    } else if (target.hasAttribute('data-delete-function') && current()) context.getDraft().functions = items().filter(item => item.id !== selectedId)
    else return
    render(); context.changed()
    root.querySelector('[data-function-field=name]')?.focus()
  }
  // input covers text, select and checkbox controls immediately, before Save can run.
  root.addEventListener('input', input); root.addEventListener('click', click)
  render()
  return { destroy() { root.removeEventListener('input', input); root.removeEventListener('click', click) } }
}
