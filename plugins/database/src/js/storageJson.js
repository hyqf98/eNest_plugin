/** Optional object fields may be absent; every stored value must otherwise be finite JSON. */
export function toStorageJson(value) {
  const seen = new Set()
  const visit = (item, path) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (!item || typeof item !== 'object') throw new Error(`${path} 必须是有效的 JSON 数据`)
    if (seen.has(item)) throw new Error(`${path} 包含循环引用`)
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error(`${path} 必须是普通 JSON 对象`)
    if (Object.getOwnPropertySymbols(item).length) throw new Error(`${path} 不能包含 Symbol 键`)
    seen.add(item)
    let result
    if (Array.isArray(item)) {
      result = []
      for (let i = 0; i < item.length; i++) {
        // Reject sparse/undefined items explicitly instead of silently storing null.
        if (!Object.hasOwn(item, i) || item[i] === undefined) throw new Error(`${path}[${i}] 不能是空项或 undefined`)
        result.push(visit(item[i], `${path}[${i}]`))
      }
    } else {
      result = Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, visit(entry, `${path}.${key}`)]))
    }
    seen.delete(item)
    return result
  }
  return visit(value, '数据')
}
