import { listDialects } from '@db/sql-intelligence/dialects/registry.js'
import { esc, options } from './formMarkup.js'
import { updateScope } from './ruleModel.js'

export const dialectOptions = () => listDialects().map(item => [item.id, item.id])

export function ruleScopeLabel(scope = {}) {
  return ['dialectId', 'connectionId', 'database', 'schema', 'table'].filter(key => Object.hasOwn(scope, key) && scope[key] !== '').map(key => scope[key] === null ? `无 ${key === 'schema' ? 'Schema' : '数据库'}` : scope[key]).join(' / ') || '全部连接与对象'
}

export function scopeMarkup(scope = {}, connections = [], { open = false } = {}) {
  const connectionsList = [['', '全部连接'], ...connections.map(item => [item.id, item.name || item.id])]
  const dialects = [['', '全部方言'], ...dialectOptions()]
  for (const [key, list] of [['connectionId', connectionsList], ['dialectId', dialects]]) if (scope[key] && !list.some(([id]) => id === scope[key])) list.push([scope[key], `${scope[key]}（配置中的值）`])
  return `<details class="sql-rule-scope" ${open ? 'open' : ''}><summary>适用范围 · <span data-rule-scope-label>${esc(ruleScopeLabel(scope))}</span></summary><div class="sql-form-grid"><label>方言<select data-rule-scope="dialectId">${options(dialects, scope.dialectId)}</select></label><label>连接<select data-rule-scope="connectionId">${options(connectionsList, scope.connectionId)}</select></label>${['database', 'schema'].map(key => nullableScopeField(key, scope)).join('')}<label>表 / 视图名称<input data-rule-scope="table" value="${esc(scope.table)}" placeholder="全部对象" maxlength="256"></label></div><p class="muted">条件同时匹配时生效；名称精确匹配。指定连接、数据库和 Schema 可区分同名对象。</p>${scope.serverVersion ? `<p class="muted">保留高级配置中的版本条件：${esc(scope.serverVersion)}</p>` : ''}</details>`
}

function nullableScopeField(key, scope) {
  const mode = !Object.hasOwn(scope, key) || scope[key] === '' ? 'any' : scope[key] === null ? 'none' : 'value'
  const label = key === 'schema' ? 'Schema' : '数据库'
  return `<label>${label}<div class="sql-rule-scope-value"><select data-rule-scope-mode="${key}" aria-label="${label}匹配方式">${options([['any', '全部'], ['value', '指定名称'], ['none', `无 ${label}`]], mode)}</select><input data-rule-scope="${key}" aria-label="${label}名称" value="${esc(scope[key])}" placeholder="${label}名称" maxlength="256" ${mode === 'value' ? '' : 'disabled'}></div></label>`
}

/** Reuse the same scope editor in functions, enums and profiles. Never replace a scope. */
export function handleScopeInput(event, root, item) {
  const target = event.target
  if (!target.hasAttribute('data-rule-scope') && !target.hasAttribute('data-rule-scope-mode')) return false
  item.scope ||= {}
  if (target.hasAttribute('data-rule-scope-mode')) {
    const key = target.dataset.ruleScopeMode
    const input = root.querySelector(`[data-rule-scope="${key}"]`)
    input.disabled = target.value !== 'value'
    updateScope(item.scope, key, input.value, target.value)
    if (!input.disabled) input.focus()
  } else updateScope(item.scope, target.dataset.ruleScope, target.value)
  const label = root.querySelector('[data-rule-scope-label]')
  if (label) label.textContent = ruleScopeLabel(item.scope)
  return true
}
