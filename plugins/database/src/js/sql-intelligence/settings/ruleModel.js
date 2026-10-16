import { resolveConfig } from '@db/sql-intelligence/configuration/index.js'

/** Form values remain strings until validated; an unfinished number never becomes null. */
export function enumValueDraft(value) {
  return { type: value === null ? 'null' : typeof value, text: value === null ? '' : String(value) }
}

export function parseEnumValue({ type, text }) {
  if (type === 'null') return { value: null }
  if (type === 'string') return { value: text }
  if (type === 'boolean') return text === 'true' || text === 'false' ? { value: text === 'true' } : { error: '请选择 true 或 false' }
  if (type === 'number') {
    const value = Number(text)
    if (!text.trim() || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) || !Number.isFinite(value)) return { error: '请输入有限数值，例如 1、-2.5 或 1e3' }
    return { value }
  }
  return { error: '不支持的值类型' }
}

/** Change exactly one condition, preserving version rules and other imported keys. */
export function updateScope(scope, key, value, mode = 'value') {
  if (mode === 'any' || mode === 'value' && value === '') delete scope[key]
  else scope[key] = mode === 'none' ? null : value
  return scope
}

/** Removing a local override restores inheritance without replacing other sections. */
export function updateOverride(profile, path, value, enabled = true) {
  const [section, key] = path.split('.')
  if (enabled) { profile.overrides[section] ||= {}; profile.overrides[section][key] = value }
  else if (profile.overrides[section]) {
    delete profile.overrides[section][key]
    if (!Object.keys(profile.overrides[section]).length) delete profile.overrides[section]
  }
}

const scopeKeys = ['dialectId', 'serverVersion', 'connectionId', 'database', 'schema', 'table']
const specificity = scope => scopeKeys.reduce((rank, key, index) => rank + (Object.hasOwn(scope || {}, key) && scope[key] !== '' ? 2 ** index : 0), 0)

/** Resolve only preceding rules, so “inherit” has the same meaning as the engine. */
export function inheritedProfileConfig(config, profile, context = {}) {
  const index = config.profiles.indexOf(profile), rank = specificity(profile.scope)
  const profiles = config.profiles.filter((item, offset) => specificity(item.scope) < rank || specificity(item.scope) === rank && offset < index)
  return resolveConfig({ ...config, profiles }, { ...context, ...profile.scope })
}
