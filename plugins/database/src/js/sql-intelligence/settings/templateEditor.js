import { clone, esc, options, uid } from './formMarkup.js'
import { dialectOptions, handleScopeInput, ruleScopeLabel, scopeMarkup } from './scopeEditor.js'

const contextOptions = [
  ['statementStart', '语句起点'], ['select', 'SELECT 字段'], ['table', 'FROM / JOIN 对象'],
  ['where', 'WHERE 条件'], ['on', 'ON 条件'], ['group', 'GROUP BY'], ['order', 'ORDER BY'],
  ['having', 'HAVING'], ['insertTable', 'INSERT 目标表'], ['insertColumns', 'INSERT 字段'],
  ['updateTable', 'UPDATE 目标表'], ['updateSet', 'UPDATE SET'], ['values', 'VALUES'], ['any', '任意 SQL 位置']
]

/** Built-ins are copied before editing; their stable ID can still be disabled. */
export function mountTemplateEditor(root, context) {
  let selectedId = ''
  const numberDrafts = new Map()
  const templates = () => context.getDraft().templates
  const current = () => templates().find(item => item.id === selectedId)
  function render() {
    if (!current()) selectedId = templates()[0]?.id || ''
    const item = current()
    root.innerHTML = `<div class="sql-section-heading"><h3>查询模板</h3><button class="btn" data-new-template>新建模板</button></div><p class="muted">输入触发词后直接接受光标下的候选。动态模板按方言生成 SQL，片段和写入模板支持 Tab 跳转占位符。</p><div class="sql-item-layout"><div class="sql-item-list" data-template-list aria-label="查询模板"></div><div class="sql-item-editor">${item ? editor(item) : '<p class="sql-empty">新建模板，复用常用查询片段。</p>'}</div></div>`
    renderList()
  }
  function renderList() {
    root.querySelector('[data-template-list]').innerHTML = templates().map(item => `<button class="sql-item ${item.id === selectedId ? 'active' : ''}" data-select-template="${esc(item.id)}" aria-pressed="${item.id === selectedId}"><strong>${esc(item.label || item.id)}</strong><small>${esc(item.trigger || '')}${item.disabled ? ' · 已停用' : ''}${item.id.startsWith('builtin.') ? ' · 内置' : ''}</small></button>`).join('')
  }
  function editor(item) {
    const builtin = item.id.startsWith('builtin.')
    const dialects = [...new Set([...dialectOptions().map(([id]) => id), ...(item.dialects || [])])]
    return `<div class="sql-inline-actions"><label class="sql-setting-check"><input type="checkbox" data-template-enabled ${item.disabled ? '' : 'checked'}>启用模板</label><button class="btn" data-copy-template>复制为自定义模板</button>${builtin ? '' : '<button class="btn" data-delete-template>删除模板</button>'}</div>${builtin ? '<p class="muted">内置模板只读。复制后可修改所有选项。</p>' : ''}<fieldset ${builtin ? 'disabled' : ''}><div class="sql-form-grid"><label>名称<input data-template-field="label" value="${esc(item.label)}" maxlength="256"></label><label>触发词<input data-template-field="trigger" value="${esc(item.trigger)}" maxlength="64"></label><label>生成方式<select data-template-field="generator">${options([['select', 'SELECT 查询'], ['insert', 'INSERT 新增'], ['update', 'UPDATE 修改'], ['snippet', 'SQL 片段']], item.generator)}</select></label></div>${item.generator === 'snippet' ? snippetMarkup(item) : dynamicMarkup(item)}<details class="sql-rule-dialects"><summary>适用方言 · <span data-template-dialect-label>${esc(item.dialects?.length ? item.dialects.join('、') : '全部')}</span></summary><p class="muted">不勾选表示全部方言。</p><div class="sql-rule-checks">${dialects.map(id => `<label class="sql-setting-check"><input type="checkbox" data-template-dialect="${esc(id)}" ${item.dialects?.includes(id) ? 'checked' : ''}>${esc(id)}</label>`).join('')}</div></details>${scopeMarkup(item.scope, context.getConnections())}</fieldset>`
  }
  function snippetMarkup(item) {
    const configured = item.contexts || ['statementStart']
    const contexts = [...contextOptions, ...configured.filter(id => !contextOptions.some(([key]) => key === id)).map(id => [id, `${id}（已配置）`])]
    return `<label>SQL 内容<textarea rows="6" data-template-body spellcheck="false" maxlength="16000">${esc(item.body || '')}</textarea></label><p class="muted">例如 ${esc('SELECT ${1:字段} FROM ${2:表名} WHERE ${3:条件}; $0')}</p><details class="sql-rule-dialects"><summary>建议位置 · <span data-template-context-label>${configured.includes('any') ? '任意 SQL 位置' : `${configured.length} 个位置`}</span></summary><div class="sql-rule-checks">${contexts.map(([id, label]) => `<label class="sql-setting-check"><input type="checkbox" data-template-context="${id}" ${configured.includes(id) ? 'checked' : ''}>${esc(label)}</label>`).join('')}</div><p class="muted">未勾选位置时不显示此片段。WHERE、ON 等只在对应子句建议。</p></details>`
  }
  function columnSetOptions(item) {
    return options([['', '对象默认字段组（没有默认时使用首组）'], ...context.getDraft().columnSets.map(set => [set.id, `${set.label} · ${ruleScopeLabel(set.scope)}${set.disabled ? ' · 已停用' : ''}`])], item.projection?.columnSetId || '')
  }
  function dynamicMarkup(item) {
    const generator = item.generator
    return `<div class="sql-form-grid"><label>字段来源<select data-template-projection>${options([['allColumns', '全部字段'], ['columnSet', '常用字段组']], item.projection?.source || 'allColumns')}</select></label>${item.projection?.source === 'columnSet' ? `<label>字段组<select data-template-column-set>${columnSetOptions(item)}</select></label>` : ''}${generator === 'select' ? `<label>返回行数<input type="number" min="1" max="10000" data-template-limit value="${esc(numberDrafts.get(item.id) ?? item.limit?.value ?? 200)}"></label><label>表别名<select data-template-alias>${options([['none', '不生成别名'], ['initials', '按表名首字母生成']], item.alias?.strategy || 'none')}</select></label>` : ''}</div><p class="muted">${generator === 'insert' ? '跳过自动生成和自增字段；按 Tab 填写 VALUES，生成后自行检查再执行。' : generator === 'update' ? '跳过主键和自动生成字段；SET 值与 WHERE 条件保留为待填写项。' : '目标表来自候选列表，返回行数语法由方言处理。'}</p><p class="muted">动态模板仅在完整新语句处建议。切换为动态生成时，建议位置设为语句起点。</p>${item.contexts && !item.contexts.some(name => name === 'statementStart' || name === 'any') ? '<p class="sql-config-issues">高级配置未允许语句起点，此动态模板可能没有候选。<button class="btn" data-template-start-context>允许语句起点</button></p>' : ''}`
  }
  function refreshDependencies() {
    const select = root.querySelector('[data-template-column-set]')
    if (select && current()) select.innerHTML = columnSetOptions(current())
  }
  function click(event) {
    const target = event.target.closest('button')
    if (!target) return
    if (target.dataset.selectTemplate) { selectedId = target.dataset.selectTemplate; render(); return }
    if (target.hasAttribute('data-new-template')) {
      const item = { id: uid('template'), label: '自定义查询', trigger: 'selnew', language: 'sql', contexts: ['statementStart'], generator: 'snippet', body: 'SELECT ${1:*}\nFROM ${2:table_name}\nWHERE ${3:condition};$0' }
      templates().push(item); selectedId = item.id
    } else if (target.hasAttribute('data-copy-template') && current()) {
      const item = { ...clone(current()), id: uid('template'), label: `${current().label} 副本`, disabled: false }
      templates().push(item); selectedId = item.id
    } else if (target.hasAttribute('data-delete-template') && current() && !current().id.startsWith('builtin.')) context.getDraft().templates = templates().filter(item => item.id !== selectedId)
    else if (target.hasAttribute('data-template-start-context') && current() && !current().id.startsWith('builtin.')) current().contexts = [...new Set([...(current().contexts || []), 'statementStart'])]
    else return
    render(); context.changed(); root.querySelector('[data-template-field=label]')?.focus()
  }
  function input(event) {
    const item = current(), target = event.target
    if (!item) return
    if (target.hasAttribute('data-template-enabled')) { item.disabled = !target.checked; renderList(); context.changed(); return }
    if (item.id.startsWith('builtin.')) return
    let edited = handleScopeInput(event, root, item)
    if (target.dataset.templateField) {
      item[target.dataset.templateField] = target.value; edited = true
      if (target.dataset.templateField === 'generator') {
        // An incomplete SELECT row count must not block a different generator.
        // Keep the last valid persisted limit; discard only the temporary text.
        numberDrafts.delete(item.id)
        if (target.value !== 'snippet') item.contexts = ['statementStart']
        render(); root.querySelector('[data-template-field=generator]')?.focus()
      }
    }
    if (target.hasAttribute('data-template-body')) { item.body = target.value; edited = true }
    if (target.hasAttribute('data-template-projection')) { item.projection = { ...item.projection, source: target.value }; render(); root.querySelector('[data-template-projection]')?.focus(); edited = true }
    if (target.hasAttribute('data-template-column-set')) {
      item.projection ||= { source: 'columnSet' }
      if (target.value) item.projection.columnSetId = target.value; else delete item.projection.columnSetId
      edited = true
    }
    if (target.hasAttribute('data-template-alias')) { item.alias = { ...item.alias, strategy: target.value }; edited = true }
    if (target.hasAttribute('data-template-limit')) {
      const value = Number(target.value)
      if (target.value !== '' && Number.isInteger(value) && value >= 1 && value <= 10000) { item.limit = { ...item.limit, value, syntax: 'dialect' }; numberDrafts.delete(item.id) }
      else numberDrafts.set(item.id, target.value)
      edited = true
    }
    if (target.dataset.templateDialect || target.dataset.templateContext) {
      const isDialect = !!target.dataset.templateDialect, key = isDialect ? 'dialects' : 'contexts'
      const selected = new Set(item[key] || (isDialect ? [] : ['statementStart'])), value = target.dataset.templateDialect || target.dataset.templateContext
      if (target.checked) selected.add(value); else selected.delete(value)
      item[key] = [...selected]
      root.querySelector(isDialect ? '[data-template-dialect-label]' : '[data-template-context-label]').textContent = isDialect ? item.dialects.join('、') || '全部' : item.contexts.includes('any') ? '任意 SQL 位置' : `${item.contexts.length} 个位置`
      edited = true
    }
    if (edited) { renderList(); context.changed() }
  }
  root.addEventListener('click', click); root.addEventListener('input', input); render()
  return {
    refresh: refreshDependencies, refreshDependencies,
    getIssues: () => templates().filter(item => numberDrafts.has(item.id)).map(item => ({ path: `模板 ${item.label || item.id} / 返回行数`, message: '需要 1–10000 的整数' })),
    destroy() { root.removeEventListener('click', click); root.removeEventListener('input', input); numberDrafts.clear() }
  }
}
