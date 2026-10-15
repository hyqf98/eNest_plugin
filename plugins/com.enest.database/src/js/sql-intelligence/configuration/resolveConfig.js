import { DEFAULT_CONFIG } from './defaults.js'
import { validateConfig } from './schema.js'

const LISTS = new Set(['columnSets', 'templates', 'functions', 'enums', 'profiles'])
const scopeKeys = ['dialectId', 'serverVersion', 'connectionId', 'database', 'schema', 'table']
const copy = value => JSON.parse(JSON.stringify(value))

/** Merge configuration without mutating persisted input or sharing default arrays. */
export function normalizeConfig(input = {}, legacyUi = {}) {
  const source = input == null ? {} : input
  const issues = validateConfig(source)
  if (issues.length) {
    const error = new Error(`SQL 智能提示配置无效：${issues[0].path} ${issues[0].message}`)
    error.issues = issues
    throw error
  }
  const config = merge(copy(DEFAULT_CONFIG), source)
  if (source.behavior?.autoAlias === undefined && typeof legacyUi.autoAliasAfterTable === 'boolean') config.behavior.autoAlias = legacyUi.autoAliasAfterTable
  if (source.behavior?.learnUsage === undefined && typeof legacyUi.learnUsage === 'boolean') config.behavior.learnUsage = legacyUi.learnUsage
  return config
}

/** An absent scope key is a wildcard; null database/schema explicitly matches no value. */
export function scopeMatches(rule = {}, context = {}) {
  return scopeKeys.every(key => {
    if (!Object.hasOwn(rule, key) || rule[key] === '') return true
    return rule[key] == null ? context[key] == null || context[key] === '' : String(rule[key]) === String(context[key] ?? '')
  })
}

/** Resolve global → dialect → connection → database/schema → table; stable IDs merge. */
export function resolveConfig(input, context = {}) {
  const normalized = normalizeConfig(input)
  let effective = copy(normalized)
  const sources = {}
  recordSources(DEFAULT_CONFIG, '内置默认', sources)
  recordSources(input || {}, '用户全局', sources)
  const profiles = normalized.profiles.filter(profile => !profile.disabled && scopeMatches(profile.scope, context))
    .map((profile, index) => ({ profile, index, rank: specificity(profile.scope) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
  for (const { profile } of profiles) {
    effective = merge(effective, profile.overrides)
    recordSources(profile.overrides, profile.label || profile.id, sources)
  }
  for (const key of LISTS) {
    if (key === 'profiles') continue
    // A statement may name another database/schema than the editor default.
    // Keep object conditions until providers bind the actual table; filter only
    // the connection, dialect and version here so unrelated sessions stay isolated.
    effective[key] = effective[key].filter(item => (key === 'templates' || !item.disabled) && scopeMatches(omitObjectScope(item.scope), context) && (!item.dialects?.length || item.dialects.includes(context.dialectId)))
  }
  effective._sources = sources
  return effective
}

/** Stable hash for invalidating candidates; property insertion order is immaterial. */
export function fingerprintConfig(input) {
  const serialized = JSON.stringify(stable(input))
  let hash = 2166136261
  for (let index = 0; index < serialized.length; index++) hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619)
  return `v1-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** Keep/import conflict resolution is explicit; arrays always merge by ID. */
export function mergeConfig(current, incoming, strategy = 'replace') {
  const first = normalizeConfig(current)
  const issues = validateConfig(incoming)
  if (issues.length) throw Object.assign(new Error(issues[0].message), { issues })
  return strategy === 'keep' ? merge(copy(incoming), first) : merge(first, incoming)
}

export function configConnectionIds(input) {
  const result = new Set()
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (value.scope?.connectionId) result.add(value.scope.connectionId)
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child === 'object') visit(child)
    }
  }
  visit(input)
  return [...result]
}

function specificity(scope = {}) {
  return scopeKeys.reduce((score, key, index) => score + (Object.hasOwn(scope, key) && scope[key] !== '' ? 2 ** index : 0), 0)
}
function omitObjectScope(scope = {}) { const { table: _table, database: _database, schema: _schema, ...rest } = scope; return rest }
function merge(base, overlay) {
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined || key.startsWith('_')) continue
    if (LISTS.has(key)) {
      const items = new Map((base[key] || []).map(item => [item.id, copy(item)]))
      for (const item of value) items.set(item.id, merge(items.get(item.id) || {}, item))
      base[key] = [...items.values()]
    } else if (value && typeof value === 'object' && !Array.isArray(value)) base[key] = merge(base[key] && typeof base[key] === 'object' ? base[key] : {}, value)
    else base[key] = value && typeof value === 'object' ? copy(value) : value
  }
  return base
}
function recordSources(value, source, output, prefix = '') {
  for (const [key, child] of Object.entries(value)) {
    if (key === 'profiles') continue
    const path = prefix ? `${prefix}.${key}` : key
    if (Array.isArray(child)) {
      for (const item of child) if (item?.id) output[`${path}.${item.id}`] = source
    } else if (child && typeof child === 'object') recordSources(child, source, output, path)
    else output[path] = source
  }
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).filter(key => !key.startsWith('_')).sort().map(key => [key, stable(value[key])]))
}
