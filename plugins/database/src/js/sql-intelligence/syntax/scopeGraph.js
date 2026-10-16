import { isName } from './tokenizer.js'

const boundaries = new Set('SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL ON USING AS GROUP ORDER HAVING LIMIT OFFSET UNION EXCEPT INTERSECT SET VALUES RETURNING WINDOW QUALIFY FOR INTO'.split(' '))

function nameAt(tokens, index, dialect) {
  if (!isName(tokens[index])) return null
  const parts = [tokens[index++]]
  while (tokens[index]?.value === '.' && isName(tokens[index + 1])) { parts.push(tokens[index + 1]); index += 2 }
  const last = parts.at(-1)
  return { name: last.value, quoted: !!last.quoted, schema: parts.length > 1 && dialect.qualifier !== 'database' ? parts.at(-2).value : undefined, database: parts.length > 2 ? parts.at(-3).value : parts.length > 1 && dialect.qualifier === 'database' ? parts.at(-2).value : undefined, parts, endIndex: index, start: parts[0].start, end: last.end }
}

function splitExpressions(tokens) {
  if (!tokens.length) return []
  const depth = Math.min(...tokens.map(token => token.depth))
  const parts = [[]]
  for (const token of tokens) {
    if (token.value === ',' && token.depth === depth) parts.push([])
    else parts.at(-1).push(token)
  }
  return parts.filter(part => part.length)
}

export function buildScopeGraph(tokens, statement, dialect) {
  const significant = tokens.filter(token => token.kind !== 'comment' && token.start >= statement.start && token.end <= statement.end)
  const pairs = new Map(), stack = []
  for (let i = 0; i < significant.length; i++) {
    const token = significant[i]
    if (token.value === '(') stack.push(i)
    if (token.value === ')' && stack.length) { const open = stack.pop(); pairs.set(open, i) }
  }
  const scopes = [{ id: 'root', start: statement.start, end: statement.end, depth: significant[0]?.depth || 0, parent: null, kind: 'query' }]
  for (let i = 0; i < significant.length; i++) {
    if (significant[i].value !== '(' || !['SELECT', 'WITH'].includes(significant[i + 1]?.upper)) continue
    const closeIndex = pairs.get(i)
    scopes.push({ id: `scope:${significant[i].start}`, open: significant[i].start, start: significant[i].end, end: closeIndex === undefined ? statement.end : significant[closeIndex].start, closeEnd: closeIndex === undefined ? statement.end : significant[closeIndex].end, depth: significant[i].depth + 1, kind: 'subquery' })
  }
  // Set-operation branches have independent FROM aliases. The container owns CTEs only.
  for (const scope of [...scopes]) {
    const operators = significant.filter(token => token.start >= scope.start && token.end <= scope.end && token.depth === scope.depth && ['UNION', 'INTERSECT', 'EXCEPT'].includes(token.upper))
    if (!operators.length) continue
    scope.kind = 'setExpression'
    let start = scope.start
    for (const operator of [...operators, { start: scope.end, end: scope.end }]) {
      scopes.push({ id: `branch:${start}`, start, end: operator.start, depth: scope.depth, kind: 'unionBranch', forcedParent: scope })
      start = operator.end
    }
  }
  for (const scope of scopes.slice(1)) scope.parent = scope.forcedParent || scopes.filter(parent => parent !== scope && parent.start <= (scope.open ?? scope.start) && parent.end >= scope.end && parent.depth < scope.depth).sort((a, b) => b.depth - a.depth || (a.end - a.start) - (b.end - b.start))[0] || scopes[0]
  for (const scope of scopes) {
    scope.tokens = significant.filter(token => token.start >= scope.start && token.end <= scope.end)
    scope.ownTokens = scope.tokens.filter(token => token.depth === scope.depth)
    scope.tables = []; scope.ctes = []
    const own = scope.ownTokens
    // WITH declarations are parsed by balanced blocks, not a flat alias regex.
    if (own[0]?.upper === 'WITH') {
      scope.recursive = own[1]?.upper === 'RECURSIVE'
      let i = own[1]?.upper === 'RECURSIVE' ? 2 : 1
      while (isName(own[i])) {
        const name = own[i++], explicitColumns = []
        if (own[i]?.value === '(') {
          const open = own[i++]
          const close = own.findIndex((item, index) => index >= i && item.value === ')')
          for (const item of scope.tokens) if (item.start > open.start && item.end <= (own[close]?.start ?? open.end) && item.depth === scope.depth + 1 && isName(item)) explicitColumns.push(item.value)
          i = close < 0 ? own.length : close + 1
        }
        if (own[i]?.upper !== 'AS') break
        i++
        if (own[i]?.upper === 'NOT' && own[i + 1]?.upper === 'MATERIALIZED') i += 2
        else if (own[i]?.upper === 'MATERIALIZED') i++
        if (own[i]?.value !== '(') break
        const open = own[i], child = scopes.find(item => item.open === open.start)
        if (!child) break
        child.kind = 'cte'; child.cteName = name.value
        scope.ctes.push({ name: name.value, quoted: !!name.quoted, columns: explicitColumns, scope: child, start: name.start })
        i++
        while (i < own.length && own[i].start < child.closeEnd) i++
        if (own[i]?.value !== ',') break
        i++
      }
    }
    if (scope.kind === 'setExpression') { scope.select = null; scope.projectionTokens = []; scope.projections = []; continue }
    let fromList = false
    for (let i = 0; i < own.length; i++) {
      const token = own[i]
      const isFrom = token.upper === 'FROM' || token.upper === 'JOIN'
      const isTarget = token.upper === 'UPDATE' || token.upper === 'INTO' && own[i - 1]?.upper === 'INSERT'
      const isComma = token.value === ',' && fromList
      if (['WHERE', 'ON', 'USING', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'SET', 'VALUES', 'RETURNING', 'UNION'].includes(token.upper)) fromList = false
      if (!isFrom && !isTarget && !isComma) continue
      if (isFrom) fromList = true
      let next = i + 1, lateral = own[next]?.upper === 'LATERAL'
      if (lateral) next++
      let reference
      if (own[next]?.value === '(') {
        const child = scopes.find(item => item.open === own[next].start)
        if (!child) continue
        child.kind = lateral ? 'lateral' : 'derived'
        next++
        while (next < own.length && own[next].start < child.closeEnd) next++
        reference = { name: '', derivedScope: child, start: own[i].start, end: child.closeEnd, kind: 'derived' }
      } else {
        reference = nameAt(own, next, dialect)
        if (!reference) continue
        next = reference.endIndex
        // Table-valued functions need a dedicated dialect provider. Do not treat them as ordinary tables.
        if (own[next]?.value === '(' && !isTarget) continue
      }
      if (own[next]?.upper === 'AS') next++
      if (isName(own[next]) && (own[next].quoted || !boundaries.has(own[next].upper))) {
        reference.alias = own[next].value; reference.aliasQuoted = !!own[next].quoted; reference.aliasEnd = own[next].end; next++
      }
      reference.alias ||= reference.name
      reference.scopeId = scope.id; reference.target = isTarget; reference.join = token.upper === 'JOIN'; reference.endIndex = next
      if (!reference.name) reference.name = reference.alias
      scope.tables.push(reference)
    }
    const selectIndex = own.findIndex(token => token.upper === 'SELECT')
    const select = own[selectIndex]
    const from = own.find((token, i) => i > selectIndex && ['FROM', 'UNION', 'EXCEPT', 'INTERSECT'].includes(token.upper))
    scope.select = select || null
    scope.projectionTokens = select ? scope.tokens.filter(token => token.start >= select.end && token.end <= (from?.start ?? scope.end) && !['DISTINCT', 'ALL'].includes(token.upper)) : []
    scope.projections = splitExpressions(scope.projectionTokens).map(part => {
      const ownPart = part.filter(token => token.depth === scope.depth)
      const as = ownPart.findIndex(token => token.upper === 'AS')
      const alias = as >= 0 && isName(ownPart[as + 1]) ? ownPart[as + 1] : ownPart.length > 1 && isName(ownPart.at(-1)) && ownPart.at(-2)?.value !== '.' && (ownPart.at(-2)?.kind !== 'word' || ownPart.length === 2) ? ownPart.at(-1) : null
      const star = ownPart.length === 1 && ownPart[0].value === '*' ? { qualifier: '' } : ownPart.length === 3 && isName(ownPart[0]) && ownPart[1].value === '.' && ownPart[2].value === '*' ? { qualifier: ownPart[0].value } : null
      const simple = ownPart.every(token => isName(token) || token.value === '.')
      return { start: part[0].start, end: part.at(-1).end, name: alias?.value || (simple ? ownPart.at(-1)?.value : undefined), star, tokens: part, quoted: alias?.quoted || (simple && ownPart.at(-1)?.quoted) }
    })
  }
  return { scopes, root: scopes[0] }
}

export function visibleReferences(scope) {
  const found = [], seen = new Set()
  for (let current = scope; current; current = ['cte', 'derived'].includes(current.kind) ? null : current.parent) {
    for (const table of current.tables) {
      const alias = table.aliasQuoted ? table.alias : table.alias.toLowerCase()
      if (seen.has(alias)) continue
      seen.add(alias); found.push(table)
    }
  }
  return found
}

export function cteFor(reference, scope, dialect) {
  for (let current = scope; current; current = current.parent) {
    const cte = current.ctes.find(item => dialect.matches(item.name, reference.name, reference.quoted))
    if (cte) {
      const declaring = current.ctes.find(item => item.scope.start <= scope.start && item.scope.end >= scope.end)
      if (declaring && cte.start >= declaring.start && !(current.recursive && cte === declaring)) return null
      return cte
    }
  }
  return null
}
