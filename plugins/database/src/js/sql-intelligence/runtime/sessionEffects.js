import { tokenizeSql, isName } from '@db/sql-intelligence/syntax/tokenizer.js'
import { getDialect } from '@db/sql-intelligence/dialects/registry.js'

function readName(words, index, dialect) {
  const parts = []
  while (isName(words[index])) {
    const token = words[index]
    parts.push(dialect.normalize(token.value, token.quoted))
    index++
    if (words[index]?.value !== '.') break
    index++
  }
  return { name: parts.at(-1), schema: parts.length > 1 ? parts.at(-2) : undefined, database: parts.length > 2 ? parts[0] : undefined, index }
}

function temporaryDefinition(words, sql, dialect) {
  let index = 3
  const ifNotExists = words[index]?.upper === 'IF'
  if (ifNotExists) index += 3
  const ref = readName(words, index, dialect)
  if (!ref.name) return null
  const columns = [], open = ref.index
  const unknown = words[open]?.value !== '(' || words.some(token => ['AS', 'SELECT', 'LIKE'].includes(token.upper))
  if (!unknown) {
    let segment = []
    const flush = () => {
      const first = segment[0]
      if (!isName(first) || ['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'KEY'].includes(first.upper)) { segment = []; return }
      const constraints = new Set(['DEFAULT', 'NOT', 'NULL', 'PRIMARY', 'REFERENCES', 'UNIQUE', 'CHECK', 'GENERATED', 'COLLATE', 'CONSTRAINT', 'AUTO_INCREMENT'])
      const typeEnd = segment.findIndex((token, i) => i > 0 && constraints.has(token.upper) && token.depth === 1)
      const typeTokens = segment.slice(1, typeEnd < 0 ? undefined : typeEnd)
      const upper = segment.map(token => token.upper)
      columns.push({ name: dialect.normalize(first.value, first.quoted), type: typeTokens.length ? sql.slice(typeTokens[0].start, typeTokens.at(-1).end) : '', generated: upper.includes('GENERATED'), autoIncrement: upper.includes('AUTO_INCREMENT'), pk: upper.includes('PRIMARY') })
      segment = []
    }
    for (const token of words.slice(open + 1)) {
      if (token.value === ')' && token.depth === 0) { flush(); break }
      if (token.value === ',' && token.depth === 1) flush()
      else segment.push(token)
    }
  }
  const known = columns.length > 0 && !unknown && !ifNotExists
  const onCommitDrop = words.some((token, i) => token.upper === 'ON' && words[i + 1]?.upper === 'COMMIT' && words[i + 2]?.upper === 'DROP')
  return { kind: 'temporary', ifNotExists, table: { name: ref.name, schema: ref.schema, database: ref.database, columns: known ? columns : [], type: 'table', temporary: true, onCommitDrop, state: known ? 'ready' : 'unknown', columnsLoaded: known, reason: known ? '' : '临时表字段尚未确认，不能从独立元数据会话读取' } }
}

/** Only confirmed session effects become facts. Failed batches may have partially run. */
export function sessionEffects(sql, dialectId, success) {
  const dialect = getDialect(dialectId)
  const tokens = tokenizeSql(sql, dialect).filter(token => token.kind !== 'comment')
  const statements = [[]]
  for (const token of tokens) {
    if (token.value === ';' && token.depth === 0) statements.push([])
    else statements.at(-1).push(token)
  }
  const effect = { invalidate: false, unknown: false, temporary: [], dropped: [], operations: [], transactionalTemporary: ['postgres', 'sqlite'].includes(dialect.baseId) }
  for (const words of statements) {
    const first = words[0]?.upper
    const ddl = ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(first)
    if (ddl) effect.invalidate = true
    if (['USE', 'SET', 'RESET', 'DISCARD'].includes(first) || first === 'ALTER' && words[1]?.upper === 'SESSION') effect.unknown = true
    const temp = first === 'CREATE' && ['TEMP', 'TEMPORARY'].includes(words[1]?.upper) && words[2]?.upper === 'TABLE'
    if (!success) {
      if (temp) {
        const definition = temporaryDefinition(words, sql, dialect)
        if (definition) effect.operations.push({ ...definition, table: { ...definition.table, state: 'unknown', columnsLoaded: false, columns: [], reason: '创建批次失败，临时表状态尚未确认' } })
      }
      if (ddl || ['COMMIT', 'END', 'ROLLBACK', 'ABORT'].includes(first)) effect.operations.push({ kind: 'uncertain' })
      continue
    }
    if (first === 'BEGIN' || first === 'START' && words[1]?.upper === 'TRANSACTION') effect.operations.push({ kind: 'begin' })
    else if (first === 'COMMIT' || first === 'END') effect.operations.push({ kind: 'commit' })
    else if (first === 'ROLLBACK' || first === 'ABORT') {
      const to = words.findIndex(token => token.upper === 'TO')
      const name = to < 0 ? null : words[to + 1]?.upper === 'SAVEPOINT' ? words[to + 2]?.value : words[to + 1]?.value
      effect.operations.push(name ? { kind: 'rollbackTo', name } : { kind: 'rollback' })
    } else if (first === 'SAVEPOINT') effect.operations.push({ kind: 'savepoint', name: words[1]?.value })
    else if (first === 'RELEASE') effect.operations.push({ kind: 'release', name: words[1]?.upper === 'SAVEPOINT' ? words[2]?.value : words[1]?.value })
    if (temp) {
      const definition = temporaryDefinition(words, sql, dialect)
      if (definition) { effect.operations.push(definition); effect.temporary.push(definition.table) }
    } else if (first === 'ALTER' || first === 'RENAME') effect.operations.push({ kind: 'uncertain' })
    if (first === 'DROP' && ['TABLE', 'TEMP', 'TEMPORARY'].includes(words[1]?.upper)) {
      let index = words.findIndex(token => token.upper === 'TABLE') + 1
      if (words[index]?.upper === 'IF') index += 2
      while (isName(words[index])) {
        const ref = readName(words, index, dialect)
        effect.operations.push({ kind: 'drop', ...ref }); effect.dropped.push(ref.name)
        index = ref.index
        if (words[index]?.value !== ',') break
        index++
      }
    }
  }
  return effect
}
