import { metadataObjectId, tableReference } from './MetadataIdentity.js'

const column = value => Object.freeze({
  name: String(value.name || value.column || ''),
  type: value.dataType || value.type || '',
  nullable: value.nullable,
  default: value.defaultValue ?? value.default,
  defaultValue: value.defaultValue ?? value.default,
  comment: value.comment || '',
  pk: !!(value.primaryKey || value.pk),
  generated: value.generated,
  hidden: value.hidden,
  invisible: value.invisible,
  isHidden: value.isHidden,
  starVisible: value.starVisible,
  isGenerated: value.isGenerated,
  computed: value.computed,
  identity: value.identity,
  autoIncrement: value.autoIncrement,
  ordinal: value.ordinal ?? value.ordinalPosition
})

/** Keep each constraint together so composite foreign keys produce one correct JOIN. */
function foreignKey(value) {
  return Object.freeze({
    name: value.name || '',
    columns: Object.freeze([...(value.columns || (value.column ? [value.column] : []))]),
    referencedDatabase: value.referencedDatabase,
    referencedSchema: value.referencedSchema,
    referencedTable: value.referencedTable || value.refTable || '',
    referencedColumns: Object.freeze([...(value.referencedColumns || (value.refColumn ? [value.refColumn] : []))])
  })
}

export function normalizeTable(scope, ref, detail = {}, columnsLoaded = false) {
  const target = tableReference(scope, ref)
  return Object.freeze({
    ...target,
    id: metadataObjectId(scope, target),
    comment: detail.comment || ref?.comment || '',
    columns: Object.freeze((detail.columns || []).map(column).filter(value => value.name)),
    foreignKeys: Object.freeze((detail.foreignKeys || detail.fks || []).map(foreignKey)),
    indexes: Object.freeze((detail.indexes || []).map(value => Object.freeze({ ...value, columns: Object.freeze([...(value.columns || [])]) }))),
    primaryKey: Object.freeze([...(detail.primaryKey || (detail.columns || []).filter(value => value.primaryKey || value.pk).map(value => value.name))]),
    columnsLoaded,
    state: columnsLoaded ? 'ready' : 'unloaded'
  })
}

export function normalizeObjectList(value) {
  const list = Array.isArray(value) ? value : value?.tables || value?.children || value?.items
  if (!Array.isArray(list)) throw new Error('数据库未返回可识别的对象目录')
  return {
    objects: list.filter(item => item && (item.name || item.table) && !['database', 'schema', 'column', 'notice', 'folder'].includes(item.type)),
    schemas: Array.isArray(value?.schemas) ? value.schemas.filter(item => typeof item === 'string') : [],
    complete: value?.complete !== false && !value?.truncated,
    reason: value?.reason || (value?.truncated ? '对象目录已截断，仍可按名称读取当前查询的表' : '')
  }
}

export function metadataError(error) {
  const reason = String(error?.message || error || '无法读取元数据')
  const status = /permission|denied|privilege|not authorized|权限/i.test(reason) ? 'permission-denied'
    : /unsupported|not support|unavailable|不支持|不可用/i.test(reason) ? 'unavailable' : 'error'
  return { status, reason }
}
