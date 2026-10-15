/** Flatten host database → schema → objects without assuming a default search_path. */
export function createCatalogReader(listTables, { maxSchemas = 64 } = {}) {
  return async ({ sessionKey, database, schema, maxObjects = 10_000, isCurrent = () => true }) => {
    const root = await listTables({ sessionKey, database, schema })
    const entries = Array.isArray(root) ? root : root?.tables || root?.children || root?.items
    if (!Array.isArray(entries) || !entries.some(item => item?.type === 'schema')) return root
    const schemas = entries.filter(item => item?.type === 'schema')
    const tables = entries.filter(item => item?.type !== 'schema')
    const reasons = [], visited = []
    let complete = root?.complete !== false && !root?.truncated
    for (const node of schemas) {
      if (!isCurrent()) throw Object.assign(new Error('元数据上下文已失效'), { code: 'STALE_METADATA' })
      if (visited.length >= maxSchemas || tables.length >= maxObjects) { complete = false; reasons.push('对象目录达到读取上限，其他对象仍可按完整名称按需读取'); break }
      const namespace = node.schema || node.name
      visited.push(namespace)
      try {
        const result = await listTables({ sessionKey, database: node.database ?? database, schema: namespace, parent: 'schema' })
        const children = Array.isArray(result) ? result : result?.tables || result?.children || result?.items
        if (!Array.isArray(children)) throw new Error('未返回可识别的对象目录')
        tables.push(...children.map(item => ({ ...item, database: item.database ?? node.database ?? database, schema: item.schema ?? namespace })))
        if (result?.complete === false || result?.truncated) { complete = false; reasons.push(`${namespace} 的对象目录未完整返回`) }
      } catch (error) {
        if (error?.code === 'STALE_METADATA') throw error
        complete = false; reasons.push(`${namespace}: ${error?.message || '无法读取对象目录'}`)
      }
    }
    return { tables, schemas: schemas.map(node => node.schema || node.name), complete, reason: reasons.join('；') }
  }
}
