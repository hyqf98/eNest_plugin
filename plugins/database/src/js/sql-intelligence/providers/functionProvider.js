import { candidate } from '@db/sql-intelligence/edits/editPlanner.js'
import { scopeMatches } from './catalogContext.js'

export function functionDefinitions(dialect, config, request, table) {
  const custom = (config.functions || []).filter(item => !item.disabled && (!item.dialects?.length || item.dialects.includes(dialect.id)) && scopeMatches(item.scope, request, table)).map(item => {
    const signature = item.signature || `${item.name}()`
    const parameters = signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')')).split(',').map(part => part.trim()).filter(Boolean)
    return { ...item, parameters, custom: true }
  })
  return [...dialect.functions, ...custom]
}

export function functionProvider({ analysis, request, config, boundTable }) {
  if (analysis.identifier.qualifier || !['select', 'where', 'having', 'on', 'order', 'group', 'updateSet', 'values'].includes(analysis.clause)) return []
  return functionDefinitions(analysis.dialect, config, request, boundTable).map(fn => {
    const parameters = fn.parameters || []
    const body = `${fn.name}(${parameters.map((parameter, index) => '${' + (index + 1) + ':' + parameter.replace(/[}$]/g, '') + '}').join(', ')})$0`
    const signature = fn.signature || `${fn.name}(${parameters.join(', ')})`
    return candidate(analysis, { kind: 'function', label: fn.name, insertText: `${fn.name}(`, detail: signature, doc: fn.description, presentation: { type: fn.returns || '', description: signature }, source: fn.custom ? 'user' : 'dialect', semanticRank: 60, editPlan: { from: analysis.identifier.from, to: analysis.identifier.to, text: `${fn.name}(${parameters.join(', ')})`, snippet: body, additionalEdits: [] } })
  })
}

export function keywordProvider({ analysis, config }) {
  if (analysis.identifier.qualifier) return []
  if (analysis.expectsTable) return []
  const allowed = {
    statementStart: ['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'EXPLAIN'],
    select: ['DISTINCT', 'FROM', 'CASE', 'NULL'], table: ['JOIN', 'LEFT', 'RIGHT', 'INNER', 'WHERE', 'AS', ...(analysis.scope.tables.at(-1)?.join ? ['ON', 'USING'] : [])],
    where: ['AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'EXISTS', 'LIKE', 'BETWEEN', 'ORDER', 'GROUP', 'LIMIT'],
    on: ['AND', 'OR', 'IS', 'NULL'], order: ['BY', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST'],
    group: ['BY', 'HAVING'], having: ['AND', 'OR'], updateSet: ['WHERE', 'NULL', 'DEFAULT'],
    insertColumns: [], insertTable: [], updateTable: ['SET'], values: ['NULL', 'DEFAULT', 'RETURNING']
  }[analysis.clause] || []
  const prefix = analysis.identifier.prefix
  const lower = config.behavior?.keywordCase === 'lower' || config.behavior?.keywordCase === 'preserve' && prefix && prefix === prefix.toLowerCase()
  return allowed.filter(word => analysis.dialect.keywords.includes(word)).map(word => candidate(analysis, { kind: 'keyword', label: word, insertText: lower ? word.toLowerCase() : word, detail: `${analysis.dialect.id} 关键字`, source: 'dialect', semanticRank: 20 }))
}

export function enumProvider({ analysis, metadata, request, config }) {
  if (!['where', 'on', 'having', 'updateSet', 'values'].includes(analysis.clause)) return []
  const before = analysis.tokens.filter(token => token.end <= analysis.identifier.from && token.kind !== 'comment')
  if (before.at(-1)?.value !== '=') return []
  const column = before.at(-2), qualifier = before.at(-3)?.value === '.' ? before.at(-4)?.value : null
  if (!column) return []
  const references = analysis.references.filter(reference => !qualifier || analysis.dialect.matches(reference.alias, qualifier))
  return (config.enums || []).filter(item => !item.disabled && item.column === column.value).flatMap(item => references.filter(reference => scopeMatches(item.scope, request, metadata.resolveTable(reference))).flatMap(reference => item.values.map(value => candidate(analysis, { id: `enum:${item.id}:${JSON.stringify(value)}`, kind: 'value', label: analysis.dialect.literal(value), insertText: analysis.dialect.literal(value), detail: `${reference.alias}.${column.value} · 用户枚举`, source: 'user', semanticRank: 150, reason: '当前字段配置的静态值' }))))
}
