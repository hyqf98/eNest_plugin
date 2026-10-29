/**
 * workflow — 画布执行引擎。
 *
 * 数据流：RunContext 是唯一真源。执行成功的节点把标准化的 outputs 写入上下文，
 * 下游 collectInputs 优先读上下文、回落该节点最近一次成功输出（data.lastRun）。
 * 因此同一次「运行全部」里下游一定能拿到本轮上游产物，不再读到运行前的旧值。
 *
 * 输出标准（execute 返回值 → 落库形态）：
 *   text  → string
 *   image → ImageRef[] { assetId, name?, createdAt? }，图片先落 storage.assets
 *   json  → 普通对象
 * 落库不存图片字节，避免草稿 KV 触顶。
 */

import { getNodeDef } from './nodeRegistry.mjs'
import { getDefaultProvider, PROVIDER_KIND } from './providers.mjs'
import { saveAsset, attachGalleryMeta, getAsset } from './assets.mjs'
import { fromDataUrl } from './netFetch.mjs'
import { PORT_KIND, normalizeOutput } from './nodeSchema.mjs'
import { resolveParams } from './variables.mjs'

/** 协议 → 供应商 kind（provider 选择按此过滤） */
const PROTOCOL_PROVIDER_KIND = {
  'openai-images': PROVIDER_KIND.IMAGES,
  'openai-chat': PROVIDER_KIND.CHAT
}

/** 运行上下文：nodeId → 本轮标准输出 */
export function createRunContext(seedNodes) {
  const pool = new Map()
  if (seedNodes) {
    for (const node of seedNodes) {
      const outputs = node?.data?.lastRun?.outputs
      if (outputs && typeof outputs === 'object') pool.set(node.id, outputs)
    }
  }
  return {
    getOutputs: nodeId => pool.get(nodeId) ?? null,
    setOutputs: (nodeId, outputs) => { pool.set(nodeId, outputs) },
    forget: nodeId => { pool.delete(nodeId) },
    clear: () => pool.clear()
  }
}

/** 从某节点沿连线正向可达的全部下游（不含自身） */
export function downstreamOf(nodeId, edges) {
  const adjacency = new Map()
  for (const e of edges) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, [])
    adjacency.get(e.source).push(e.target)
  }
  const seen = new Set([nodeId])
  const queue = [...(adjacency.get(nodeId) ?? [])]
  const result = []
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    queue.push(...(adjacency.get(id) ?? []))
  }
  return result
}

/** nodes/edges → 层级拓扑；环则抛错 */
export function topoLevels(nodes, edges) {
  const indegree = new Map(nodes.map(n => [n.id, 0]))
  const outgoing = new Map(nodes.map(n => [n.id, []]))
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue
    outgoing.get(edge.source).push(edge.target)
    indegree.set(edge.target, indegree.get(edge.target) + 1)
  }
  const levels = []
  let frontier = nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id)
  const seen = new Set()
  while (frontier.length) {
    levels.push(frontier)
    const next = []
    for (const id of frontier) {
      seen.add(id)
      for (const target of outgoing.get(id) ?? []) {
        indegree.set(target, indegree.get(target) - 1)
        if (indegree.get(target) === 0 && !seen.has(target)) next.push(target)
      }
    }
    frontier = next
  }
  if (seen.size !== nodes.length) throw new Error('画布中存在环：请检查连线')
  return levels
}

/**
 * 收集某节点的输入。
 * - multiple 输入口：合并全部入边为数组
 * - 单值输入口：取第一条有效入边（顺序稳定，不因遍历顺序抖动）
 */
function collectInputs(node, edges, nodesById, getOutputs) {
  const def = getNodeDef(node.data.type)
  const inputs = {}
  const claimed = new Set()
  for (const edge of edges) {
    if (edge.target !== node.id) continue
    const targetPort = edge.targetHandle || 'default'
    const sourcePort = edge.sourceHandle || 'default'
    const portDef = def?.inputs.find(p => p.key === targetPort)
    if (!portDef) continue
    const source = nodesById.get(edge.source)
    if (!source) continue
    const value = getOutputs(edge.source)?.[sourcePort]
      ?? source?.data?.lastRun?.outputs?.[sourcePort]
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && !value.length) continue

    if (portDef.multiple) {
      const list = Array.isArray(value) ? value : [value]
      inputs[targetPort] = [...(inputs[targetPort] ?? []), ...list]
    } else if (!claimed.has(targetPort)) {
      claimed.add(targetPort)
      inputs[targetPort] = Array.isArray(value) ? value[0] : value
    }
  }
  return inputs
}

/** asset 引用 → {bytes, mime}（get 回 dataUrl 再解码） */
async function resolveImageRef(ref) {
  if (!ref) return null
  if (ref.bytes instanceof Uint8Array) return { bytes: ref.bytes, mime: ref.mime ?? 'image/png' }
  if (ref.dataUrl) return fromDataUrl(ref.dataUrl)
  const asset = await getAsset(ref.assetId)
  if (!asset?.dataUrl) throw new Error(`图片资源不可用：${ref.assetId ?? ''}`)
  return fromDataUrl(asset.dataUrl)
}

/** 图片输入标准化：恒为 {bytes,mime}[]；无上游时回落旧草稿的 data.localImage */
async function resolveImageInputs(node, def, inputs) {
  for (const port of def.inputs) {
    if (port.kind !== PORT_KIND.IMAGE) continue
    const empty = inputs[port.key] === undefined
      || (Array.isArray(inputs[port.key]) && !inputs[port.key].length)
    if (empty && node.data.localImage?.assetId) inputs[port.key] = [{ assetId: node.data.localImage.assetId }]
    if (inputs[port.key] === undefined) continue
    const refs = Array.isArray(inputs[port.key]) ? inputs[port.key] : [inputs[port.key]]
    const resolved = []
    for (const ref of refs) {
      const image = await resolveImageRef(ref)
      if (image) resolved.push(image)
    }
    inputs[port.key] = resolved
  }
  return inputs
}

/** 图片输出落盘：已是 assetId 引用的不重复保存 */
async function persistImageOutputs(node, images, meta) {
  const out = []
  for (const [index, image] of images.entries()) {
    if (image?.assetId && !image.bytes) {
      out.push({ assetId: image.assetId, name: image.name ?? null, createdAt: image.createdAt ?? null })
      continue
    }
    const saved = await saveAsset({
      bytes: image.bytes, mime: image.mime,
      name: `${node.data.type}-${node.id.slice(0, 6)}-${index + 1}`
    })
    out.push({ assetId: saved.assetId, name: saved.name ?? null, createdAt: saved.createdAt ?? Date.now() })
    await attachGalleryMeta(saved.assetId, {
      prompt: meta.prompt, providerName: meta.providerName, model: meta.model,
      nodeId: node.id, draftId: meta.draftId, at: Date.now()
    })
  }
  return out
}

/**
 * 执行单个节点（不递归上游）。
 * @returns 更新后的 data 片段（state/lastRun），由调用方合回 React Flow 节点
 */
export async function executeNode(node, { edges, nodesById, providers, draftId, runContext, onProgress }) {
  const def = getNodeDef(node.data.type)
  if (!def) throw new Error(`未知节点类型：${node.data.type}`)

  const getOutputs = id => runContext?.getOutputs(id) ?? null
  const inputs = await resolveImageInputs(node, def, collectInputs(node, edges, nodesById, getOutputs))

  const { params, missing } = resolveParams(def, node.data.params ?? {}, {
    nodeId: node.id, nodes: Array.from(nodesById.values()), edges, getOutputs
  })

  const providerId = node.data.providerId
  const requiredKind = def.protocol ? (PROTOCOL_PROVIDER_KIND[def.protocol] ?? PROVIDER_KIND.IMAGES) : null
  const provider = (providerId && providers.find(p => p.id === providerId))
    || (requiredKind ? await getDefaultProvider(providers, requiredKind) : null)
  if (def.protocol && !provider?.secretRef) throw new Error('尚未配置 API 密钥：请先在设置中完成对应供应商配置')

  const startedAt = Date.now()
  const result = await def.execute({ inputs, params, provider, onProgress })
  const durationMs = Date.now() - startedAt

  const galleryMeta = {
    prompt: String(params.prompt ?? inputs.prompt ?? params.template ?? ''),
    providerName: provider?.name ?? '', model: provider?.model ?? '',
    draftId
  }
  const outputs = {}
  for (const port of def.outputs) {
    const value = normalizeOutput(port, result.outputs?.[port.key])
    outputs[port.key] = port.kind === PORT_KIND.IMAGE
      ? await persistImageOutputs(node, Array.isArray(value) ? value : [], galleryMeta)
      : value
  }
  runContext?.setOutputs(node.id, outputs)

  const patch = {
    state: 'success',
    error: null,
    warnings: missing.length ? [`未解析的变量引用：${Array.from(new Set(missing)).join('、')}`] : [],
    lastRun: {
      at: Date.now(), durationMs, outputs,
      // 输入快照：运行日志面板展示"输入是什么"；图片只留引用，文本截断
      inputs: snapshotInputs(def, inputs),
      resolvedParams: params, usage: result.usage ?? null,
      display: result.display ?? null
    }
  }
  return patch
}

/** 输入快照（紧凑、可 JSON 序列化）：文本截断 200 字，图片只留 assetId */
function snapshotInputs(def, inputs) {
  const out = {}
  for (const port of def?.inputs ?? []) {
    const value = inputs[port.key]
    if (value === undefined || value === null) continue
    if (port.kind === PORT_KIND.IMAGE) {
      const list = Array.isArray(value) ? value : [value]
      out[port.key] = list.map(item => item?.assetId).filter(Boolean)
    } else if (typeof value === 'string') {
      out[port.key] = value.length > 200 ? `${value.slice(0, 200)}…` : value
    } else {
      out[port.key] = value
    }
  }
  return out
}

/** 整画布运行：层级推进，同层并行 ≤4；onNodeState(nodeId, statePatch) 实时回报 */
export async function runWorkflow({ nodes, edges, providers, draftId, onNodeState, shouldStop, runContext }) {
  const levels = topoLevels(nodes, edges)
  const nodesById = new Map(nodes.map(n => [n.id, n]))
  // 默认从当前 lastRun 起步：上下文由本轮逐层刷新，下游一定读到本轮上游新产物
  const context = runContext ?? createRunContext(nodes)
  const failed = new Set()
  for (const level of levels) {
    if (shouldStop?.()) break
    const runnable = level.filter(id => {
      const node = nodesById.get(id)
      if (!node) return false
      const upstreamFailed = edges.some(e => e.target === id && failed.has(e.source))
      if (upstreamFailed) {
        onNodeState(id, { state: 'error', error: '上游节点失败，已跳过' })
        failed.add(id)
        return false
      }
      return !!getNodeDef(node.data.type)
    })
    const batch = []
    for (const id of runnable) {
      if (shouldStop?.()) break
      const node = nodesById.get(id)
      onNodeState(id, { state: 'running', error: null })
      batch.push(executeNode(node, { edges, nodesById, providers, draftId, runContext: context })
        .then(patch => onNodeState(id, patch))
        .catch(error => {
          failed.add(id)
          onNodeState(id, { state: 'error', error: error instanceof Error ? error.message : String(error) })
        }))
      if (batch.length >= 4) await Promise.all(batch.splice(0))
    }
    await Promise.all(batch)
  }
  return { ok: failed.size === 0, failed: Array.from(failed) }
}
