import { tokenizeSql, identifierAt, isName } from './tokenizer.js'
import { buildScopeGraph, visibleReferences } from './scopeGraph.js'

export function analyzeSql(sql, cursor, dialect) {
  cursor = Math.max(0, Math.min(Number.isFinite(cursor) ? cursor : sql.length, sql.length))
  const tokens = tokenizeSql(sql, dialect)
  const boundaries = tokens.filter(token => token.value === ';' && token.depth === 0)
  const start = boundaries.filter(token => token.end <= cursor).at(-1)?.end || 0
  const end = boundaries.find(token => token.start >= cursor)?.start ?? sql.length
  const statement = { start, end, text: sql.slice(start, end) }
  const graph = buildScopeGraph(tokens, statement, dialect)
  const scope = graph.scopes.filter(item => item.start <= cursor && item.end >= cursor).sort((a, b) => b.depth - a.depth || (a.end - a.start) - (b.end - b.start))[0] || graph.root
  const identifier = identifierAt(sql, cursor, tokens)
  const lexicalToken = tokens.find(token => token.start < cursor && (token.end > cursor || token.end === cursor && (token.incomplete || token.kind === 'comment' && !token.text.endsWith('*/'))))
  const suppressed = ['string', 'comment'].includes(lexicalToken?.kind)
  const before = scope.ownTokens.filter(token => token.end <= cursor && token.start < identifier.from)
  let clause = 'statementStart'
  for (let i = 0; i < before.length; i++) {
    const word = before[i].upper
    if (word === 'SELECT') clause = 'select'
    else if (word === 'FROM' || word === 'JOIN') clause = 'table'
    else if (['WHERE', 'HAVING', 'ON'].includes(word)) clause = word.toLowerCase()
    else if (word === 'ORDER' || word === 'GROUP') clause = word.toLowerCase()
    else if (word === 'UPDATE') clause = 'updateTable'
    else if (word === 'SET') clause = 'updateSet'
    else if (word === 'INTO' && before[i - 1]?.upper === 'INSERT') clause = 'insertTable'
    else if (word === 'VALUES') clause = 'values'
  }
  const last = before.at(-1)
  const ownBefore = scope.tokens.filter(token => token.end <= cursor)
  const target = scope.tables.find(table => table.target)
  if (target && clause === 'insertTable' && ownBefore.some(token => token.value === '(' && token.start >= target.end)) clause = 'insertColumns'
  const references = visibleReferences(scope)
  const expectsTable = ['table', 'insertTable', 'updateTable'].includes(clause) && (!!identifier.qualifier || ['FROM', 'JOIN', 'INTO', 'UPDATE', 'LATERAL'].includes(last?.upper) || last?.value === ',')
  const referencedTables = graph.scopes.flatMap(item => item.tables).filter(table => !table.derivedScope).map(({ derivedScope, ...table }) => table)
  const statementKind = graph.root.ownTokens.find(token => isName(token))?.upper || ''
  const unsafeProjection = scope.ownTokens.some(token => ['NATURAL', 'USING', 'EXCEPT', 'REPLACE', 'EXCLUDE'].includes(token.upper))
  return { sql, cursor, tokens, statement, scope, scopes: graph.scopes, references, referencedTables, identifier, clause, expectsTable, lastToken: last, suppressed, statementKind, unsafeProjection, dialect }
}
