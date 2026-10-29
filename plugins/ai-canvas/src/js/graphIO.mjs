/**
 * graphIO — 画布 JSON 导入 / 导出（节点标准化序列化）。
 * 只序列化可迁移的语义数据：节点类型、自定义标题、参数、位置，以及连线端点。
 * 运行态（state/error/warnings/lastRun）与资源句柄不导出；导入时按注册表校验类型，
 * 未知类型跳过并给出警告，避免旧图或第三方图把画布搞坏。
 */
import { getNodeDef } from './nodeRegistry.mjs'
import { createNodeData, defaultParams, PORT_KIND } from './nodeSchema.mjs'

export const GRAPH_SCHEMA = 'ai-canvas/graph'
export const GRAPH_VERSION = 1

/** 画布 → JSON 文本 */
export function serializeGraph(nodes, edges, { name = '' } = {}) {
  const payload = {
    schema: GRAPH_SCHEMA,
    version: GRAPH_VERSION,
    name,
    exportedAt: new Date().toISOString(),
    nodes: nodes.map(node => ({
      id: node.id,
      type: node.data?.type,
      title: node.data?.title ?? '',
      position: { x: Math.round(node.position?.x ?? 0), y: Math.round(node.position?.y ?? 0) },
      params: sanitizeParams(node.data?.type, node.data?.params)
    })),
    edges: edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? null,
      target: edge.target,
      targetHandle: edge.targetHandle ?? null
    }))
  }
  return JSON.stringify(payload, null, 2)
}

/** 参数只保留 def 声明过的键，避免把界面临时态写进文件 */
function sanitizeParams(type, params) {
  const def = getNodeDef(type)
  if (!def) return {}
  const out = {}
  for (const param of def.params) {
    const value = params?.[param.key]
    if (value === undefined) continue
    // 图片参数只留 assetId 引用
    if (param.type === 'image') {
      if (value?.assetId) out[param.key] = { assetId: value.assetId, name: value.name ?? null }
      continue
    }
    // 目录句柄只在当前实例有效，不导出（导入后需重选）
    if (param.type === 'directory') continue
    out[param.key] = value
  }
  return out
}

/**
 * JSON 文本 → { nodes, edges, warnings }
 * 校验 schema/version/节点类型/端口；不合法整体抛错，局部问题进 warnings。
 */
export function parseGraph(text) {
  let data
  try { data = JSON.parse(text) } catch { throw new Error('不是合法的 JSON 文件') }
  if (!data || typeof data !== 'object') throw new Error('JSON 顶层不是对象')
  if (data.schema !== GRAPH_SCHEMA) throw new Error(`不是 AI 画布图文件（schema=${data.schema ?? '缺失'}）`)
  if (Number(data.version) > GRAPH_VERSION) throw new Error(`图文件版本 ${data.version} 高于当前支持的 ${GRAPH_VERSION}`)
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('缺少 nodes / edges 数组')

  const warnings = []
  const nodes = []
  const ids = new Set()
  for (const raw of data.nodes) {
    const def = getNodeDef(raw?.type)
    if (!def) { warnings.push(`跳过未知节点类型：${raw?.type ?? '(空)'}`); continue }
    if (!raw.id || ids.has(raw.id)) { warnings.push(`跳过无效或重复的节点 id：${raw?.id ?? '(空)'}`); continue }
    ids.add(raw.id)
    const params = { ...defaultParams(def) }
    for (const param of def.params) {
      const value = raw.params?.[param.key]
      if (value === undefined) continue
      if (param.type === 'image') {
        if (value?.assetId) params[param.key] = { assetId: value.assetId, name: value.name ?? null }
      } else {
        params[param.key] = value
      }
    }
    nodes.push({
      id: raw.id,
      type: 'registry',
      position: { x: Number(raw.position?.x) || 0, y: Number(raw.position?.y) || 0 },
      data: createNodeData(def, { params, title: typeof raw.title === 'string' ? raw.title : '' })
    })
  }

  const edges = []
  const seen = new Set()
  for (const raw of data.edges) {
    if (!ids.has(raw?.source) || !ids.has(raw?.target)) { warnings.push(`跳过端点缺失的连线：${raw?.id ?? '(空)'}`); continue }
    const key = `${raw.source}:${raw.sourceHandle ?? ''}->${raw.target}:${raw.targetHandle ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({
      id: raw.id || key,
      type: 'handdrawn',
      source: raw.source, sourceHandle: raw.sourceHandle ?? undefined,
      target: raw.target, targetHandle: raw.targetHandle ?? undefined
    })
  }
  if (!nodes.length) throw new Error('文件里没有可用节点')
  return { nodes, edges, warnings, name: typeof data.name === 'string' ? data.name : '' }
}

/** 供 UI 展示：某端口的取值形态提示 */
export function describePortKind(kind) {
  return kind === PORT_KIND.IMAGE ? '图片' : kind === PORT_KIND.JSON ? '对象' : '文本'
}
