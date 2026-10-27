/**
 * nodeRegistry — 节点类型注册表（纯 registry，无业务定义）。
 *
 * 节点定义在 nodeDefs/ 下按类型各占一个文件，经 nodeDefs/index.mjs 汇总注册。
 * 新增节点 = 新建一个定义文件 + 在 index.mjs 加一行 import，本文件无需改动。
 */

const REGISTRY = new Map()

export function registerNode(def) {
  REGISTRY.set(def.type, def)
  return def
}

export function getNodeDef(type) { return REGISTRY.get(type) }

export function listNodeDefs() { return Array.from(REGISTRY.values()) }

/** 按分类分组（保持注册顺序），供节点库与节点选择器共用 */
export function groupNodeDefs(defs = listNodeDefs()) {
  const groups = []
  const index = new Map()
  for (const def of defs) {
    const category = def.category ?? '其他'
    if (!index.has(category)) {
      index.set(category, { category, defs: [] })
      groups.push(index.get(category))
    }
    index.get(category).defs.push(def)
  }
  return groups
}
