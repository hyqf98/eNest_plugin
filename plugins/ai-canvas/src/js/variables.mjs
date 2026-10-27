/**
 * variables — 跨节点变量引用。
 *
 * 两条数据流并存：
 *  1. 连线注入（主路径）：端口 kind 匹配即自动传值，行为与旧版一致。
 *  2. 变量引用（叠加）：文本参数里写 {{#nodeId.portKey#}} 精确取上游输出。
 *
 * 引用只能指向图上可达的上游节点（反向 BFS 求集合），杜绝前向引用与自引用。
 * 解析不到时原样保留并记入 missing，由节点标出警告而不是静默丢字。
 */

import { PORT_KIND } from './nodeSchema.mjs'
import { getNodeDef } from './nodeRegistry.mjs'

export const VAR_REF_PATTERN = /\{\{#([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\}\}/g
const INLINE_TEXT_LIMIT = 4000

export function varSelector(nodeId, portKey) { return `{{#${nodeId}.${portKey}#}}` }

/** 反向可达集合：能沿连线到达 nodeId 的全部上游节点（不含自身） */
export function upstreamNodeIds(nodeId, edges) {
  const reverse = new Map()
  for (const edge of edges) {
    if (!reverse.has(edge.target)) reverse.set(edge.target, [])
    reverse.get(edge.target).push(edge.source)
  }
  const seen = new Set([nodeId])
  const result = []
  const queue = [...(reverse.get(nodeId) ?? [])]
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    queue.push(...(reverse.get(id) ?? []))
  }
  return result
}

/** 端口取值：本轮运行上下文优先，回落节点最近一次成功运行 */
export function readPortValue(node, portKey, getOutputs) {
  const outputs = getOutputs?.(node?.id) ?? node?.data?.lastRun?.outputs ?? null
  return outputs ? outputs[portKey] : null
}

/** 值 → 可插入文本的字符串 */
export function stringifyValue(port, value) {
  if (value == null) return ''
  if (port?.kind === PORT_KIND.IMAGE) {
    const list = Array.isArray(value) ? value : [value]
    return list.map(item => item?.assetId ?? '').filter(Boolean).join('\n')
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

/**
 * 变量选择器数据源：按上游节点分组，组内按输出端口展开。
 * 组顺序按节点 x 倒序（离当前节点越近越靠前），与 Dify 一致。
 */
export function listUpstreamVariables({ nodeId, nodes, edges, getOutputs }) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const groups = []
  for (const id of upstreamNodeIds(nodeId, edges)) {
    const node = byId.get(id)
    if (!node) continue
    const def = getNodeDef(node.data?.type)
    if (!def?.outputs?.length) continue
    const outputs = getOutputs?.(id) ?? node.data?.lastRun?.outputs ?? null
    groups.push({
      nodeId: id,
      title: def.title,
      glyph: def.glyph,
      x: node.position?.x ?? 0,
      vars: def.outputs.map(port => ({
        portKey: port.key,
        label: port.label ?? port.key,
        kind: port.kind,
        multiple: !!port.multiple,
        value: outputs ? outputs[port.key] : undefined,
        selector: varSelector(id, port.key)
      }))
    })
  }
  groups.sort((a, b) => b.x - a.x)
  return groups
}

/** 按 {{#nodeId.portKey#}} 插值：只解析上游可达节点，其余原样保留并记入 missing */
export function interpolate(text, { nodeId, nodes, edges, getOutputs }) {
  const source = String(text ?? '')
  if (!source.includes('{{#')) return { text: source, missing: [] }
  const byId = new Map(nodes.map(node => [node.id, node]))
  const allowed = new Set(upstreamNodeIds(nodeId, edges))
  const missing = []
  const out = source.replace(VAR_REF_PATTERN, (raw, id, portKey) => {
    if (!allowed.has(id)) { missing.push(raw); return raw }
    const node = byId.get(id)
    const def = getNodeDef(node?.data?.type)
    const port = def?.outputs?.find(item => item.key === portKey)
    if (!port) { missing.push(raw); return raw }
    const value = readPortValue(node, portKey, getOutputs)
    if (value == null || (Array.isArray(value) && !value.length)) { missing.push(raw); return raw }
    const rendered = stringifyValue(port, value)
    return rendered.length > INLINE_TEXT_LIMIT ? rendered.slice(0, INLINE_TEXT_LIMIT) : rendered
  })
  return { text: out, missing }
}

/** 参数层插值：只处理声明了 acceptsVariable 的参数 */
export function resolveParams(def, params, context) {
  const resolved = { ...(params ?? {}) }
  const missing = []
  for (const param of def?.params ?? []) {
    if (!param.acceptsVariable) continue
    const raw = resolved[param.key]
    if (typeof raw !== 'string' || !raw.includes('{{#')) continue
    const result = interpolate(raw, context)
    resolved[param.key] = result.text
    missing.push(...result.missing)
  }
  return { params: resolved, missing }
}
