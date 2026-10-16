import { createDialog, escapeHtml as esc } from '@enest/plugin-kit/workbench'
import { DbHost } from './api.js'
import { runDatabaseTask } from './operationTask.js'

const types = ['integer', 'bigint', 'decimal', 'float', 'varchar', 'text', 'boolean', 'date', 'timestamp', 'json', 'uuid', 'binary']
const operations = { 'create-table': '新建表', 'add-column': '新增字段', 'rename-column': '重命名字段', 'drop-column': '删除字段', 'create-index': '创建索引', 'drop-index': '删除索引' }

/** Structured design requests are compiled by the host; preview text is never executed as input. */
export function openTableDesigner({ sessionKey, table = {}, detail, readOnly, taskContext = {}, isCurrent, onApplied }) {
  const existing = !!table.table
  let columns = [{ name: '', type: 'integer', nullable: false, primaryKey: true }], previewedDesign, revision = 0, applying = false
  const modal = createDialog({ title: existing ? `表设计 · ${table.table}` : '设计新表', className: 'wide wb-table-designer', content: `<p class="muted">先预览数据库实际执行的 DDL，再确认执行。已有事务必须先提交或回滚。</p><div class="form-grid"><label>操作<select data-operation>${Object.entries(operations).filter(([id]) => existing ? id !== 'create-table' : id === 'create-table').map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label><label>表名<input data-table value="${esc(table.table || '')}" ${existing ? 'readonly' : ''}></label><label>数据库<input data-database value="${esc(table.database || '')}"></label><label>Schema<input data-schema value="${esc(table.schema || '')}"></label></div><div data-design-fields></div><div class="form-actions"><button class="btn" data-preview>预览 DDL</button><span class="spacer"></span><button class="btn primary" data-apply disabled>确认执行</button></div><p data-status role="status"></p><div data-preview-output></div>` })
  const root = modal.body, value = (name) => root.querySelector(`[data-${name}]`)?.value.trim() || '', status = root.querySelector('[data-status]'), apply = root.querySelector('[data-apply]')
  const invalidate = () => { revision++; previewedDesign = null; apply.disabled = true; root.querySelector('[data-preview-output]').innerHTML = '' }
  const renderFields = () => {
    const op = value('operation'), target = root.querySelector('[data-design-fields]'); invalidate()
    if (['create-table', 'add-column'].includes(op)) {
      if (op === 'add-column') columns = columns.slice(0, 1)
      target.innerHTML = `<div class="wb-design-columns">${columns.map((col, index) => `<div class="wb-design-column" data-column="${index}"><input data-prop="name" value="${esc(col.name)}" aria-label="字段名称" placeholder="字段名称"><select data-prop="type" aria-label="字段类型">${types.map((type) => `<option ${col.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select><input data-prop="length" value="${esc(col.length || '')}" aria-label="长度或精度与小数位" placeholder="长度 / 精度,小数位"><input data-prop="default" value="${esc(col.default || '')}" aria-label="默认值" placeholder="默认值（留空不设）"><label><input data-prop="nullable" type="checkbox" ${col.nullable ? 'checked' : ''}>可空</label>${op === 'create-table' ? `<label><input data-prop="primaryKey" type="checkbox" ${col.primaryKey ? 'checked' : ''}>主键</label><button class="btn" data-remove="${index}" aria-label="移除字段">×</button>` : ''}</div>`).join('')}</div>${op === 'create-table' ? '<button class="btn" data-add>添加字段</button>' : ''}`
      target.querySelectorAll('[data-prop]').forEach((input) => input.oninput = () => { const col = columns[Number(input.closest('[data-column]').dataset.column)]; col[input.dataset.prop] = input.type === 'checkbox' ? input.checked : input.value; invalidate() })
      target.querySelector('[data-add]')?.addEventListener('click', () => { columns.push({ name: '', type: 'varchar', length: 255, nullable: true }); renderFields() })
      target.querySelectorAll('[data-remove]').forEach((button) => button.onclick = () => { columns.splice(Number(button.dataset.remove), 1); renderFields() })
    } else if (['rename-column', 'drop-column'].includes(op)) target.innerHTML = `<label class="wb-field">字段<select data-existing-column>${(detail?.columns || []).map((col) => `<option>${esc(col.name)}</option>`).join('')}</select></label>${op === 'rename-column' ? '<label class="wb-field">新名称<input data-new-name></label>' : '<p class="wb-form-error">删除字段会删除该字段的数据。</p>'}`
    else if (op === 'create-index') target.innerHTML = '<div class="form-grid"><label>索引名称<input data-index-name></label><label>字段（逗号分隔）<input data-index-columns></label><label><input type="checkbox" data-unique>唯一索引</label></div>'
    else target.innerHTML = `<label class="wb-field">索引<select data-index-name>${(detail?.indexes || []).map((index) => `<option>${esc(index.name)}</option>`).join('')}</select></label>`
  }
  const readColumn = (col) => {
    if (!col.name.trim()) throw new Error('请填写所有字段名称')
    const output = { name: col.name.trim(), type: col.type, nullable: !!col.nullable }
    if (col.length) { if (col.type === 'decimal') { const [precision, scale] = String(col.length).split(','); output.precision = Number(precision); output.scale = Number(scale || 0) } else output.length = Number(col.length) }
    if (col.default?.trim()) { const raw = col.default.trim(); output.default = /^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(raw) ? { kind: 'expression', value: raw.toUpperCase() } : { kind: 'literal', value: /^null$/i.test(raw) ? null : /^(true|false)$/i.test(raw) ? raw.toLowerCase() === 'true' : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw } }
    return output
  }
  const read = () => {
    const operation = value('operation'), ref = { table: value('table'), database: value('database') || undefined, schema: value('schema') || undefined }
    if (!ref.table) throw new Error('请填写表名')
    const design = { operation, table: ref }
    if (operation === 'create-table') { if (!columns.length) throw new Error('至少需要一个字段'); design.columns = columns.map(readColumn); design.primaryKey = columns.filter((col) => col.primaryKey).map((col) => col.name.trim()) }
    else if (operation === 'add-column') design.column = readColumn(columns[0])
    else if (operation === 'rename-column') { design.column = value('existing-column'); design.newName = value('new-name') }
    else if (operation === 'drop-column') design.column = value('existing-column')
    else { design.name = value('index-name'); if (operation === 'create-index') { design.columns = value('index-columns').split(',').map((name) => name.trim()).filter(Boolean); design.unique = root.querySelector('[data-unique]').checked } }
    return design
  }
  root.addEventListener('input', invalidate); root.querySelector('[data-operation]').onchange = renderFields
  root.querySelector('[data-preview]').onclick = async (event) => {
    event.target.disabled = true; status.textContent = '正在生成 DDL…'
    try { const ticket = revision, design = read(); const preview = await DbHost.workbench('table.design.preview', { sessionKey, design }); if (ticket !== revision) { status.textContent = '设计已变化，请重新预览'; return }; previewedDesign = design; root.querySelector('[data-preview-output]').innerHTML = `<p class="${preview.destructive ? 'wb-form-error' : 'muted'}">${esc((preview.warnings || []).join(' '))}</p><textarea class="wb-sql-preview" readonly aria-label="DDL 预览">${esc(preview.sql)}</textarea>`; status.textContent = readOnly ? '当前控制台只读，可查看 DDL，不能执行。' : '请核对 DDL 后确认执行。'; apply.disabled = !!readOnly } catch (error) { status.textContent = error.message } finally { event.target.disabled = false }
  }
  apply.onclick = async () => {
    if (!previewedDesign || readOnly || applying) return
    const design = previewedDesign
    applying = true; root.querySelectorAll('input,select,button').forEach(element => { element.disabled = true }); status.textContent = '正在执行表设计…'
    try {
      if (isCurrent?.() === false) throw new Error('来源连接已断开，请重新打开表设计')
      await runDatabaseTask({ ...taskContext, kind: 'tableDesign', sessionKey }, () => DbHost.workbench('table.design.apply', { sessionKey, design, confirmed: true }))
      status.textContent = '表设计已应用'; previewedDesign = null; await onApplied?.()
    } catch (error) { status.textContent = error.message }
    finally { applying = false; root.querySelectorAll('input,select,button').forEach(element => { element.disabled = false }); apply.disabled = !previewedDesign || !!readOnly }
  }
  renderFields()
  return modal
}
