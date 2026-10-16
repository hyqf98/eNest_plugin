import { jsonCompletionContext } from './jsonContext.js'

export const RULE_KINDS = { topic: 'Topic / 队列', header: 'Header 名称', jsonKey: 'JSON 字段', jsonValue: 'JSON 字段值' }
export const PROTOCOLS = ['kafka', 'rabbitmq', 'mqtt', 'rocketmq']
const controls = /[\x00-\x1f\x7f-\x9f]/
const placeholders = new Set(['connection.id', 'connection.name', 'environment', 'protocol', 'input'])
export const defaultCompletion = () => ({ autoSuggest: true, builtins: true, rules: [] })

export function validateCompletion(value = {}) {
  const rules = value.rules ?? []
  if (!Array.isArray(rules) || rules.length > 200) throw new Error('提示规则最多 200 条')
  const ids = new Set()
  const clean = rules.map((rule, index) => {
    const name = `第 ${index + 1} 条规则`
    if (!rule || !RULE_KINDS[rule.kind]) throw new Error(`${name}：请选择规则类型`)
    if (typeof rule.id !== 'string' || !rule.id || ids.has(rule.id)) throw new Error(`${name}：规则标识无效或重复`)
    ids.add(rule.id)
    const text = key => typeof rule[key] === 'string' ? rule[key].trim() : ''
    const output = { id: rule.id, enabled: rule.enabled !== false, kind: rule.kind, label: text('label'), trigger: text('trigger'), field: text('field'), value: text('value'), protocol: text('protocol'), connectionId: text('connectionId') }
    if (!output.label || output.label.length > 80) throw new Error(`${name}：名称需要 1–80 个字符`)
    if (output.protocol && !PROTOCOLS.includes(output.protocol)) throw new Error(`${name}：协议无效`)
    if (output.trigger.length > 120 || output.field.length > 240 || output.connectionId.length > 200) throw new Error(`${name}：触发词或范围过长`)
    if (!output.value || output.value.length > 8192 || controls.test(output.label + output.trigger + output.field) || rule.kind !== 'jsonValue' && controls.test(output.value)) throw new Error(`${name}：内容不能为空、包含控制字符或超过 8 KiB`)
    if (rule.kind === 'jsonValue') {
      if (!output.field) throw new Error(`${name}：请指定 JSON 字段或字段路径`)
      try { JSON.parse(output.value) } catch { throw new Error(`${name}：字段值必须是有效 JSON，例如 "created"、true 或 200`) }
    } else {
      if (output.value.length > 512) throw new Error(`${name}：候选内容最多 512 个字符`)
      for (const match of output.value.matchAll(/\$\{([^}]+)\}/g)) if (rule.kind !== 'topic' || !placeholders.has(match[1])) throw new Error(`${name}：不支持变量 ${match[0]}`)
      if (output.value.replace(/\$\{[^}]+\}/g, '').includes('${')) throw new Error(`${name}：模板变量未闭合`)
    }
    return output
  })
  return { autoSuggest: value.autoSuggest !== false, builtins: value.builtins !== false, rules: clean }
}
export function matchingRules(preferences, kind, connection = {}) {
  return (preferences?.rules || []).filter(rule => rule.enabled !== false && rule.kind === kind && (!rule.protocol || rule.protocol === connection.kind) && (!rule.connectionId || rule.connectionId === connection.id))
}
function expandTopic(value, input, connection) {
  const values = { 'connection.id': connection.id || '', 'connection.name': connection.name || '', environment: connection.env || '', protocol: connection.kind || '', input }
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => values[name] ?? '')
}
export function namedSuggestions(value, caret, { kind = 'topic', names = [], connection = {}, preferences = defaultCompletion() } = {}) {
  const prefix = value.toLowerCase(), seen = new Set()
  const items = matchingRules(preferences, kind, connection).filter(rule => `${rule.label} ${rule.trigger} ${rule.value}`.toLowerCase().includes(prefix) || rule.trigger && prefix.startsWith(rule.trigger.toLowerCase())).map(rule => {
    const text = kind === 'topic' ? expandTopic(rule.value, value, connection) : rule.value
    return { label: rule.label, detail: `${text} · 自定义`, text, from: 0, to: value.length }
  })
  if (preferences.builtins !== false) items.push(...names.filter(name => name.toLowerCase().includes(prefix)).map(name => ({ label: name, detail: kind === 'header' ? '常用 Header' : '当前连接', text: name, from: 0, to: value.length })))
  return items.filter(item => !seen.has(item.text) && !!seen.add(item.text))
}
export function jsonRuleSuggestions(value, caret, preferences, connection) {
  const context = jsonCompletionContext(value, caret)
  if (!context) return []
  const kind = context.role === 'key' ? 'jsonKey' : 'jsonValue'
  return matchingRules(preferences, kind, connection).flatMap(rule => {
    if (kind === 'jsonKey' && rule.field && rule.field !== context.path.join('.')) return []
    if (kind === 'jsonValue' && rule.field !== context.field && rule.field !== context.path.join('.')) return []
    const raw = kind === 'jsonKey' ? rule.value : JSON.parse(rule.value)
    if (context.quoted && typeof raw !== 'string') return []
    const searchable = `${rule.label} ${rule.trigger} ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`.toLowerCase()
    if (context.prefix && !searchable.includes(context.prefix.toLowerCase())) return []
    const encoded = JSON.stringify(raw)
    const text = context.quoted ? encoded.slice(1, -1) + (context.closed ? '' : '"') : encoded + (kind === 'jsonKey' ? ': ' : '')
    return [{ label: rule.label, detail: `${rule.value} · ${kind === 'jsonKey' ? '自定义字段' : rule.field}`, text, from: context.from, to: context.to }]
  })
}
