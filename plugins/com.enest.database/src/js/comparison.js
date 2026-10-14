/** Data comparison is deliberately read-only. No migration/synchronisation SQL is generated. */
export function compareRows(left, right, keyColumns) {
  if (!keyColumns.length) throw new Error('请选择用于对齐的唯一键列')
  const leftNames = left.columns.map((col) => col.name), rightNames = right.columns.map((col) => col.name)
  for (const name of keyColumns) if (!leftNames.includes(name) || !rightNames.includes(name)) throw new Error(`两侧缺少键列 ${name}`)
  const encode = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $bigint: item.toString() } : item)
  const index = (result, names) => {
    const map = new Map()
    for (const row of result.rows || []) {
      const key = encode(keyColumns.map((name) => row[names.indexOf(name)]))
      map.set(key, [...(map.get(key) || []), row])
    }
    return map
  }
  const l = index(left, leftNames), r = index(right, rightNames)
  const columns = [...new Set([...leftNames, ...rightNames])]
  return [...new Set([...l.keys(), ...r.keys()])].map((key) => {
    const ls = l.get(key), rs = r.get(key)
    const row = { key, left: ls?.[0], right: rs?.[0] }
    if (ls?.length > 1 || rs?.length > 1) return { ...row, status: 'ambiguous' }
    if (!ls) return { ...row, status: 'right-only' }
    if (!rs) return { ...row, status: 'left-only' }
    const equal = columns.every((name) => leftNames.includes(name) && rightNames.includes(name) && encode(ls[0][leftNames.indexOf(name)]) === encode(rs[0][rightNames.indexOf(name)]))
    return { ...row, status: equal ? 'equal' : 'different' }
  })
}

export function isReadQuery(sql) {
  const clean = String(sql).replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
  return /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(clean) && !/\b(INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+UPDATE)\b/i.test(clean) && !/;\s*\S/.test(clean)
}

export function structureDiff(left, right) {
  const fields = (detail) => {
    const objects = new Map()
    for (const column of detail.columns || []) objects.set(`column:${column.name}`, { kind: 'column', name: column.name, type: column.dataType || column.type, nullable: column.nullable, default: column.defaultValue ?? column.default, primaryKey: !!(column.pk || column.primaryKey) })
    for (const index of detail.indexes || []) objects.set(`index:${index.name}`, { kind: 'index', name: index.name, columns: index.columns, unique: !!index.unique })
    for (const key of detail.foreignKeys || []) objects.set(`foreign-key:${key.name}`, { kind: 'foreign-key', name: key.name, columns: key.columns, referencedSchema: key.referencedSchema, referencedTable: key.referencedTable || key.targetTable, referencedColumns: key.referencedColumns, onDelete: key.onDelete, onUpdate: key.onUpdate })
    return objects
  }
  const l = fields(left), r = fields(right)
  return [...new Set([...l.keys(), ...r.keys()])].map((key) => ({ key, left: l.get(key), right: r.get(key), status: !l.has(key) ? 'right-only' : !r.has(key) ? 'left-only' : JSON.stringify(l.get(key)) === JSON.stringify(r.get(key)) ? 'equal' : 'different' }))
}
