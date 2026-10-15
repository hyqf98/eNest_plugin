import { DEFAULT_CONFIG } from './defaults.js'

/** No SQL or JavaScript is executed while validating configuration. */
export const CONFIG_LIMITS = Object.freeze({ bytes: 262144, items: 200, columns: 2000, body: 16000 })

const bool = { type: 'boolean' }
const text = (max = 256) => ({ type: 'string', max })
const choice = (...values) => ({ values })
const number = (min, max) => ({ type: 'number', min, max, integer: true })
const array = (item, max = CONFIG_LIMITS.items) => ({ type: 'array', item, max })
const object = (fields, required = []) => ({ type: 'object', fields, required })
const scope = object({ connectionId: text(), dialectId: text(), database: { ...text(), nullable: true }, schema: { ...text(), nullable: true }, table: text(), serverVersion: text() })
const contexts = choice('statementStart', 'select', 'from', 'join', 'where', 'on', 'groupBy', 'orderBy', 'having', 'insert', 'update', 'values', 'expression', 'any', 'table', 'order', 'group', 'insertTable', 'insertColumns', 'updateTable', 'updateSet')
const common = { id: text(), disabled: bool }
const sectionFields = {
  behavior: object({ automatic: bool, delayMs: number(0, 2000), minPrefixLength: number(0, 8), acceptOnEnter: bool, acceptOnTab: bool, keywordCase: choice('upper', 'lower', 'preserve'), autoAlias: bool, starExpansion: choice('suggest', 'off'), learnUsage: bool, commentSearch: bool, maxItems: number(10, 500) }),
  columnSets: array(object({ ...common, label: text(), scope, columns: array(text(), CONFIG_LIMITS.columns), order: choice('configured', 'schema'), default: bool }, ['id'])),
  templates: array(object({ ...common, label: text(), trigger: text(64), language: choice('sql'), contexts: array(contexts, 20), generator: choice('select', 'insert', 'update', 'snippet'), body: text(CONFIG_LIMITS.body), dialects: array(text(), 50), scope, projection: object({ source: choice('allColumns', 'columnSet'), columnSetId: text(), choose: bool }), table: object({ source: choice('picker') }), alias: object({ strategy: choice('initials', 'none'), avoidCollisions: bool }), limit: object({ value: number(1, 10000), syntax: choice('dialect') }) }, ['id'])),
  functions: array(object({ ...common, name: text(), signature: text(2000), description: text(4000), dialects: array(text(), 50), scope }, ['id'])),
  enums: array(object({ ...common, column: text(), values: array({ scalar: true }, 500), scope }, ['id'])),
  ranking: object({ pinned: array(text(1000), 500), usageWeight: number(0, 20) }),
  metadata: object({ ttlMs: number(1000, 86400000), maxObjects: number(10, 10000), prefetch: choice('referenced', 'none') }),
  diagnostics: object({ selectStar: choice('off', 'hint', 'warning'), duplicateAlias: choice('off', 'hint', 'warning', 'error'), unknownColumn: choice('off', 'hint', 'warning'), unsafeMutation: choice('off', 'hint', 'warning') })
}
const configSchema = object({ schemaVersion: choice(1), ...sectionFields, profiles: array(object({ ...common, label: text(), scope, overrides: object(sectionFields) }, ['id', 'scope', 'overrides'])) })
const builtinIds = new Set(DEFAULT_CONFIG.templates.map(item => item.id))

/** Returns structured, displayable issues. Missing sections inherit defaults. */
export function validateConfig(input) {
  const issues = []
  const issue = (path, message) => issues.push({ path, message })
  let bytes = 0
  try { bytes = new TextEncoder().encode(JSON.stringify(input)).length } catch { return [{ path: '$', message: '配置必须是可序列化的 JSON 对象' }] }
  if (bytes > CONFIG_LIMITS.bytes) return [{ path: '$', message: '配置不能超过 256 KB' }]
  validate(input, configSchema, '$', issue)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return issues
  validateLists(input, '$', issue)
  if (Array.isArray(input.profiles)) input.profiles.forEach((profile, index) => {
    if (profile?.overrides && typeof profile.overrides === 'object') validateLists(withInheritedItems(profile.overrides, input), `$.profiles[${index}].overrides`, issue)
    if (profile?.scope && !Object.values(profile.scope).some(value => value != null && value !== '')) issue(`$.profiles[${index}].scope`, '覆盖规则需要至少一个作用域条件')
  })
  if (Array.isArray(input.columnSets)) {
    const ids = new Set(input.columnSets.map(item => item?.id))
    for (const profile of Array.isArray(input.profiles) ? input.profiles : []) for (const item of Array.isArray(profile?.overrides?.columnSets) ? profile.overrides.columnSets : []) ids.add(item?.id)
    for (const [index, template] of (Array.isArray(input.templates) ? input.templates : []).entries()) {
      if (template && !template.disabled && template.projection?.columnSetId && !ids.has(template.projection.columnSetId)) issue(`$.templates[${index}].projection.columnSetId`, '引用的字段组不存在')
    }
  }
  return issues
}

function validate(value, schema, path, issue) {
  if (value === null && schema.nullable) return
  if (schema.scalar) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) issue(path, '枚举值仅支持文本、数值、布尔值或 null')
    if (typeof value === 'string' && value.length > 2000) issue(path, '枚举值过长')
    if (typeof value === 'number' && !Number.isFinite(value)) issue(path, '数值必须有限')
    return
  }
  if (schema.values) { if (!schema.values.includes(value)) issue(path, `允许值：${schema.values.join('、')}`); return }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) { issue(path, '需要数组'); return }
    if (value.length > schema.max) issue(path, `最多 ${schema.max} 项`)
    value.slice(0, schema.max + 1).forEach((item, index) => validate(item, schema.item, `${path}[${index}]`, issue))
    return
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) { issue(path, '需要普通对象'); return }
    for (const field of schema.required || []) if (value[field] == null || value[field] === '') issue(`${path}.${field}`, '此项必填')
    for (const field of Object.keys(value)) {
      if (!Object.hasOwn(schema.fields, field)) { issue(`${path}.${field}`, '未知配置项'); continue }
      validate(value[field], schema.fields[field], `${path}.${field}`, issue)
    }
    return
  }
  if (typeof value !== schema.type) { issue(path, `需要 ${schema.type === 'boolean' ? '布尔值' : schema.type === 'number' ? '数值' : '文本'}`); return }
  if (schema.type === 'string' && value.length > schema.max) issue(path, `不能超过 ${schema.max} 个字符`)
  if (schema.type === 'number' && (!Number.isFinite(value) || value < schema.min || value > schema.max || (schema.integer && !Number.isInteger(value)))) issue(path, `需要 ${schema.min}–${schema.max} 的整数`)
}

function validateLists(input, path, issue) {
  for (const name of ['columnSets', 'templates', 'functions', 'enums', 'profiles']) {
    if (!Array.isArray(input[name])) continue
    const ids = new Set()
    input[name].forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return
      const at = `${path}.${name}[${index}]`
      if (typeof entry.id === 'string') {
        if (!entry.id.trim()) issue(`${at}.id`, 'ID 不能为空')
        if (ids.has(entry.id)) issue(`${at}.id`, 'ID 重复')
        ids.add(entry.id)
      }
      if (name === 'columnSets' && Array.isArray(entry.columns) && (!entry.columns.length || new Set(entry.columns).size !== entry.columns.length || entry.columns.some(value => typeof value === 'string' && !value.trim()))) issue(`${at}.columns`, '至少选择一个字段，名称不能为空或重复')
      if (name === 'templates') {
        if (entry.trigger && /\s/.test(entry.trigger)) issue(`${at}.trigger`, '触发词不能包含空格')
        if (entry.body && /\$\{(?!\d+(?::[^}]*)?\})/.test(entry.body)) issue(`${at}.body`, '模板只支持 $0、$1 或 ${1:默认值} 占位符')
        if (entry.generator === 'snippet' && (typeof entry.body !== 'string' || !entry.body.trim())) issue(`${at}.body`, '静态模板需要 SQL 内容')
      }
      if (entry.disabled || builtinIds.has(entry.id)) return
      const required = { columnSets: ['label', 'scope', 'columns'], templates: ['label', 'trigger', 'generator'], functions: ['name', 'signature'], enums: ['column', 'scope', 'values'] }[name] || []
      for (const field of required) if (entry[field] == null || entry[field] === '') issue(`${at}.${field}`, '此项必填')
      if (name === 'columnSets') {
        if (!entry.scope?.table) issue(`${at}.scope.table`, '字段组需要指定表')
      }
    })
  }
}

/** An override may be partial only when its global/default definition supplies
 * the missing fields. A new scoped item must have a complete definition. */
function withInheritedItems(overrides, root) {
  const result = { ...overrides }
  for (const name of ['columnSets', 'templates', 'functions', 'enums']) {
    if (!Array.isArray(overrides[name])) continue
    const inherited = new Map()
    for (const item of [...DEFAULT_CONFIG[name], ...(Array.isArray(root[name]) ? root[name] : [])]) {
      if (item && typeof item === 'object') inherited.set(item.id, { ...inherited.get(item.id), ...item })
    }
    result[name] = overrides[name].map(item => {
      if (!item || typeof item !== 'object') return item
      const base = inherited.get(item.id)
      if (!base) return item
      const merged = { ...base, ...item }
      for (const key of ['scope', 'projection', 'alias', 'limit']) if (base[key] && item[key] && typeof item[key] === 'object') merged[key] = { ...base[key], ...item[key] }
      return merged
    })
  }
  return result
}
