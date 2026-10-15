import { DEFAULT_CONFIG } from '@db/sql-intelligence/configuration/index.js'
import { clone, esc, options, uid } from './formMarkup.js'
import { handleScopeInput, ruleScopeLabel, scopeMarkup } from './scopeEditor.js'
import { inheritedProfileConfig, updateOverride } from './ruleModel.js'

const booleanOptions = [['true', '开启'], ['false', '关闭']]
const diagnosticLevels = [['off', '关闭'], ['hint', '提示'], ['warning', '警告']]
const fields = [
  { path: 'behavior.automatic', label: '输入时自动提示', type: 'boolean' },
  { path: 'behavior.acceptOnEnter', label: 'Enter 接受候选', type: 'boolean' },
  { path: 'behavior.acceptOnTab', label: 'Tab 接受候选', type: 'boolean' },
  { path: 'behavior.autoAlias', label: '表名补全附加别名', type: 'boolean' },
  { path: 'behavior.learnUsage', label: '按使用频率排序', type: 'boolean' },
  { path: 'behavior.commentSearch', label: '搜索字段备注', type: 'boolean' },
  { path: 'behavior.keywordCase', label: '关键词大小写', options: [['upper', '大写'], ['lower', '小写'], ['preserve', '保持原样']] },
  { path: 'behavior.starExpansion', label: '星号展开', options: [['suggest', '显示展开建议'], ['off', '关闭展开建议']] },
  { path: 'behavior.delayMs', label: '提示延迟（毫秒）', type: 'number', min: 0, max: 2000 },
  { path: 'behavior.minPrefixLength', label: '最少输入字符', type: 'number', min: 0, max: 8 },
  { path: 'behavior.maxItems', label: '最多候选数', type: 'number', min: 10, max: 500 },
  { path: 'diagnostics.selectStar', label: 'SELECT *', options: diagnosticLevels },
  { path: 'diagnostics.duplicateAlias', label: '重复别名', options: [...diagnosticLevels, ['error', '错误']] },
  { path: 'diagnostics.unknownColumn', label: '无法确认的字段', options: diagnosticLevels },
  { path: 'diagnostics.unsafeMutation', label: '无条件 UPDATE / DELETE', options: diagnosticLevels }
]
const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object)
const valueLabel = (field, value) => field.type === 'boolean' ? value ? '开启' : '关闭' : field.options?.find(([key]) => key === value)?.[1] || String(value)

/** Visual overrides edit only the chosen properties; other imported rules stay intact. */
export function mountProfileEditor(root, context) {
  let selectedId = ''
  const numberDrafts = new Map()
  const items = () => context.getDraft().profiles
  const current = () => items().find(item => item.id === selectedId)
  const numberKey = path => `${selectedId}:${path}`
  function inherited() {
    const active = context.getScope(), connectionId = current().scope?.connectionId
    const connection = context.getConnections().find(item => item.id === connectionId)
    const scope = connectionId && connectionId !== active.connectionId
      ? { connectionId, dialectId: connection?.dialectId || connection?.driver, database: connection?.database, schema: connection?.schema }
      : active
    try { return inheritedProfileConfig(context.getDraft(), current(), scope) }
    catch { return { ...DEFAULT_CONFIG, _sources: {}, _invalid: true } }
  }
  function render() {
    if (!current()) selectedId = items()[0]?.id || ''
    const item = current(), index = items().indexOf(item)
    root.innerHTML = `<div class="sql-section-heading"><h3>局部规则与继承</h3><button class="btn" data-new-profile>新建局部规则</button></div><p class="muted">全局 → 方言 → 连接 → 数据库 / Schema → 表依次覆盖。同一层按列表顺序生效，后面的规则优先。</p><div class="sql-item-layout"><div class="sql-item-list" data-profile-list aria-label="局部规则"></div><div class="sql-item-editor">${item ? `<div class="sql-inline-actions"><label class="sql-setting-check"><input type="checkbox" data-profile-enabled ${item.disabled ? '' : 'checked'}>启用规则</label><button class="btn" data-copy-profile>复制规则</button><button class="btn" data-delete-profile>删除规则</button><button class="btn" data-move-profile="-1" ${index === 0 ? 'disabled' : ''} aria-label="规则上移">↑</button><button class="btn" data-move-profile="1" ${index === items().length - 1 ? 'disabled' : ''} aria-label="规则下移">↓</button></div><label>规则名称<input data-profile-label value="${esc(item.label)}" maxlength="256" placeholder="例如：订单库查询偏好"></label>${scopeMarkup(item.scope, context.getConnections(), { open: true })}<p class="muted">勾选需要覆盖的选项；取消勾选即可恢复继承。表级规则仅在当前 SQL 能明确解析为单一表时应用。</p><div data-profile-overrides></div>${Object.keys(item.overrides || {}).some(key => !['behavior', 'diagnostics'].includes(key)) ? '<p class="muted">此规则还包含高级配置中的其他覆盖项；修改下列选项会保留这些内容。</p>' : ''}` : '<p class="sql-empty">为特定方言、连接或表覆盖少量选项，其余继续继承全局设置。</p>'}</div></div>`
    renderList(); renderOverrides()
  }
  function renderList() {
    root.querySelector('[data-profile-list]').innerHTML = items().map(item => `<button class="sql-item ${selectedId === item.id ? 'active' : ''}" data-select-profile="${esc(item.id)}" aria-pressed="${selectedId === item.id}"><strong>${esc(item.label || item.id)}</strong><small>${item.disabled ? '已停用 · ' : ''}${esc(ruleScopeLabel(item.scope))}</small></button>`).join('')
  }
  function renderOverrides() {
    const item = current(), panel = root.querySelector('[data-profile-overrides]')
    if (!item || !panel) return
    const base = inherited()
    panel.innerHTML = `${base._invalid ? '<p class="muted">草稿尚有无效项，暂时显示内置默认值；修正后将重新计算继承来源。</p>' : ''}${['behavior', 'diagnostics'].map(section => `<div class="sql-rule-override-group"><h4>${section === 'behavior' ? '补全行为' : 'SQL 提醒'}</h4>${fields.filter(field => field.path.startsWith(section + '.')).map(field => overrideRow(field, item, base)).join('')}</div>`).join('')}`
  }
  function overrideRow(field, item, base) {
    const local = get(item.overrides, field.path), enabled = local !== undefined
    const value = enabled ? numberDrafts.get(numberKey(field.path)) ?? local : get(base, field.path)
    const control = field.type === 'number' ? `<input type="number" data-profile-value="${field.path}" aria-label="${field.label}局部值" min="${field.min}" max="${field.max}" value="${esc(value)}" ${enabled ? '' : 'disabled'}>` : `<select data-profile-value="${field.path}" aria-label="${field.label}局部值" ${enabled ? '' : 'disabled'}>${options(field.type === 'boolean' ? booleanOptions : field.options, value)}</select>`
    return `<div class="sql-rule-override-row"><label class="sql-setting-check"><input type="checkbox" data-profile-override="${field.path}" ${enabled ? 'checked' : ''}><span>${field.label}</span></label>${control}<small>继承：${esc(valueLabel(field, get(base, field.path)))} · ${esc(base._sources?.[field.path] || '内置默认')}</small></div>`
  }
  function input(event) {
    const item = current(), target = event.target
    if (!item) return
    let edited = handleScopeInput(event, root, item)
    if (edited) renderOverrides()
    if (target.hasAttribute('data-profile-label')) { item.label = target.value; edited = true }
    if (target.hasAttribute('data-profile-enabled')) { item.disabled = !target.checked; edited = true }
    if (target.dataset.profileOverride) {
      const path = target.dataset.profileOverride
      updateOverride(item, path, get(inherited(), path), target.checked)
      numberDrafts.delete(numberKey(path)); renderOverrides()
      root.querySelector(`[data-profile-override="${path}"]`)?.focus(); edited = true
    }
    if (target.dataset.profileValue) {
      const path = target.dataset.profileValue, field = fields.find(field => field.path === path)
      let value = target.value
      if (field.type === 'boolean') value = value === 'true'
      if (field.type === 'number') {
        numberDrafts.set(numberKey(path), value)
        if (value !== '' && Number.isInteger(Number(value)) && Number(value) >= field.min && Number(value) <= field.max) { updateOverride(item, path, Number(value)); numberDrafts.delete(numberKey(path)) }
      } else updateOverride(item, path, value)
      edited = true
    }
    if (edited) { renderList(); context.changed() }
  }
  function click(event) {
    const target = event.target.closest('button')
    if (!target) return
    if (target.dataset.selectProfile) { selectedId = target.dataset.selectProfile; render(); return }
    if (target.hasAttribute('data-new-profile')) {
      const active = context.getScope()
      const item = { id: uid('profile'), label: '新局部规则', scope: active.connectionId ? { connectionId: active.connectionId } : { dialectId: active.dialectId || 'mysql' }, overrides: {} }
      items().push(item); selectedId = item.id
    } else if (target.hasAttribute('data-copy-profile') && current()) {
      const item = { ...clone(current()), id: uid('profile'), label: `${current().label || '规则'} · 副本` }
      items().push(item); selectedId = item.id
    } else if (target.hasAttribute('data-delete-profile') && current()) context.getDraft().profiles = items().filter(item => item.id !== selectedId)
    else if (target.dataset.moveProfile && current()) {
      const index = items().indexOf(current()), to = index + Number(target.dataset.moveProfile)
      if (to < 0 || to >= items().length) return
      items().splice(to, 0, items().splice(index, 1)[0])
    } else return
    render(); context.changed(); root.querySelector('[data-profile-label]')?.focus()
  }
  root.addEventListener('input', input); root.addEventListener('click', click)
  render()
  return {
    getIssues: () => items().flatMap(item => fields.filter(field => numberDrafts.has(`${item.id}:${field.path}`)).map(field => ({ path: `${item.label || item.id} / ${field.label}`, message: `需要 ${field.min}–${field.max} 的整数` }))),
    refresh: renderOverrides,
    destroy() { root.removeEventListener('input', input); root.removeEventListener('click', click); numberDrafts.clear() }
  }
}
