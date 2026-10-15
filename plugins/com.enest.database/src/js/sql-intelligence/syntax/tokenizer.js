/** Offset-preserving lexer; incomplete quotes/comments are first-class tokens. */
export function tokenizeSql(sql, dialect = {}) {
  const tokens = []
  const mysql = dialect.baseId === 'mysql' || ['mysql', 'mariadb', 'tidb'].includes(dialect.id)
  let offset = 0, depth = 0
  const push = (kind, start, value, extra = {}) => tokens.push({ kind, start, end: offset, text: sql.slice(start, offset), value, upper: String(value).toUpperCase(), depth, ...extra })
  while (offset < sql.length) {
    const start = offset, ch = sql[offset]
    if (/\s/.test(ch)) { offset++; continue }
    const dashComment = ch === '-' && sql[offset + 1] === '-' && (!mysql || offset + 2 === sql.length || /[\s\x00-\x1f]/.test(sql[offset + 2]))
    if (dashComment || ch === '#' && mysql) {
      while (offset < sql.length && sql[offset] !== '\n') offset++
      push('comment', start, sql.slice(start, offset)); continue
    }
    if (ch === '/' && sql[offset + 1] === '*') {
      offset += 2; let nesting = 1
      while (offset < sql.length && nesting) {
        if (sql.slice(offset, offset + 2) === '/*') { nesting++; offset += 2 }
        else if (sql.slice(offset, offset + 2) === '*/') { nesting--; offset += 2 }
        else offset++
      }
      push('comment', start, sql.slice(start, offset), { incomplete: !!nesting }); continue
    }
    const dollar = ch === '$' && dialect.baseId === 'postgres' ? /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(offset))?.[0] : null
    if (dollar) {
      const end = sql.indexOf(dollar, offset + dollar.length)
      offset = end < 0 ? sql.length : end + dollar.length
      push('string', start, sql.slice(start, offset), { incomplete: end < 0 }); continue
    }
    const oracleAlternative = ch === "'" && dialect.baseId === 'oracle' && tokens.at(-1)?.upper === 'Q' && tokens.at(-1)?.end === start
    if (oracleAlternative) {
      const opening = sql[offset + 1], closing = ({ '[': ']', '{': '}', '(': ')', '<': '>' })[opening] || opening
      const end = sql.indexOf(`${closing}'`, offset + 2)
      offset = end < 0 ? sql.length : end + 2
      push('string', start, sql.slice(start, offset), { incomplete: end < 0, alternativeQuote: true }); continue
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[' && ['mssql', 'sqlite'].includes(dialect.baseId)) {
      const close = ch === '[' ? ']' : ch
      const escapeString = mysql || dialect.baseId === 'postgres' && tokens.at(-1)?.upper === 'E' && tokens.at(-1)?.end === start
      let value = '', closed = false
      offset++
      while (offset < sql.length) {
        if (sql[offset] === close) {
          if (sql[offset + 1] === close) { value += close; offset += 2; continue }
          offset++; closed = true; break
        }
        if (sql[offset] === '\\' && (ch === "'" || mysql && ch === '"') && escapeString && offset + 1 < sql.length) { value += sql[offset + 1]; offset += 2 }
        else value += sql[offset++]
      }
      push(ch === "'" ? 'string' : 'identifier', start, value, { quoted: ch !== "'", quote: ch, incomplete: !closed }); continue
    }
    if (/[\p{L}_$]/u.test(ch)) {
      offset++
      while (offset < sql.length && /[\p{L}\p{N}_$]/u.test(sql[offset])) offset++
      push('word', start, sql.slice(start, offset)); continue
    }
    if (/[0-9]/.test(ch)) {
      offset++
      while (offset < sql.length && /[0-9.]/.test(sql[offset])) offset++
      push('number', start, sql.slice(start, offset)); continue
    }
    if (ch === ')') depth = Math.max(0, depth - 1)
    offset++
    push('punctuation', start, ch)
    if (ch === '(') depth++
  }
  return tokens
}

export function isName(token) { return token?.kind === 'word' || token?.kind === 'identifier' }

export function identifierAt(sql, cursor, tokens) {
  const token = tokens.find(item => isName(item) && item.start <= cursor && item.end >= cursor)
  let from = token?.start ?? cursor, to = token?.end ?? cursor
  let prefix = token ? sql.slice(token.start + (token.quoted ? 1 : 0), cursor) : ''
  if (token?.quoted && prefix.endsWith(token.quote === '[' ? ']' : token.quote)) prefix = prefix.slice(0, -1)
  const before = tokens.filter(item => item.end <= from && item.kind !== 'comment')
  const parts = []
  for (let index = before.length - 1; index >= 1 && before[index]?.value === '.' && isName(before[index - 1]); index -= 2) parts.unshift(before[index - 1])
  return { from, to, prefix, qualifier: parts.map(item => item.value).join('.'), qualifierParts: parts, quoted: !!token?.quoted, token }
}
