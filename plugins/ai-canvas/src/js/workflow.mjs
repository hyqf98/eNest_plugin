/**
 * workflow — 画布执行引擎。
 * 拓扑排序（环检测）+ 双模式运行：
 *  - runNode：单节点运行，输入取上游节点最近一次成功输出（Dify 同款）
 *  - runAll：整画布按层级推进，同层并行 ≤4，失败节点标错并跳过其下游
 * 生成图片经 assets 落盘，节点 data.lastRun 持久化 asset 引用（不存图数据）。
 */

import { getNodeDef } from './nodeRegistry.mjs'
import { getDefaultProvider } from './providers.mjs'
import { saveAsset, attachGalleryMeta, getAsset } from './assets.mjs'
import { fromDataUrl } from './netFetch.mjs'

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

/** 收集某节点某输入口的全部上游输出（多入边合并为数组） */
function collectInputs(nodeId, edges, nodesById) {
  const inputs = {}
  for (const edge of edges) {
    if (edge.target !== nodeId) continue
    const targetPort = edge.targetHandle || 'default'
    const sourcePort = edge.sourceHandle || 'default'
    const source = nodesById.get(edge.source)
    const value = source?.data?.lastRun?.outputs?.[sourcePort]
    if (value === undefined || value === null) continue
    const def = getNodeDef(nodesById.get(nodeId)?.data?.type)
    const portDef = def?.inputs.find(p => p.key === targetPort)
    if (portDef?.multiple || Array.isArray(inputs[targetPort])) {
      inputs[targetPort] = [...(inputs[targetPort] ?? []), ...(Array.isArray(value) ? value : [value])]
    } else {
      inputs[targetPort] = value
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

/**
 * 执行单个节点（不递归上游）。
 * 图片输入（上游输出/本地上传的 asset 引用）先解析为字节数据再交给节点协议。
 * @returns 更新后的 data 片段（state/lastRun），由调用方合回 React Flow 节点
 */
export async function executeNode(node, { edges, nodesById, providers, draftId, onProgress }) {
  const def = getNodeDef(node.data.type)
  if (!def) throw new Error(`未知节点类型：${node.data.type}`)
  const inputs = collectInputs(node.id, edges, nodesById)
  const params = node.data.params ?? {}

  // 图片口：无上游连线时回落到节点本地上传图
  for (const port of def.inputs) {
    if (port.kind !== 'image') continue
    const empty = inputs[port.key] === undefined || (Array.isArray(inputs[port.key]) && !inputs[port.key].length)
    if (empty && node.data.localImage?.assetId) inputs[port.key] = [{ assetId: node.data.localImage.assetId }]
  }
  // asset 引用 → bytes
  for (const port of def.inputs) {
    if (port.kind !== 'image' || inputs[port.key] === undefined) continue
    const refs = Array.isArray(inputs[port.key]) ? inputs[port.key] : [inputs[port.key]]
    const resolved = []
    for (const ref of refs) {
      const image = await resolveImageRef(ref)
      if (image) resolved.push(image)
    }
    inputs[port.key] = Array.isArray(inputs[port.key]) ? resolved : resolved[0]
  }

  const providerId = node.data.providerId
  const provider = (providerId && providers.find(p => p.id === providerId)) || await getDefaultProvider(providers)
  if (def.protocol && !provider?.secretRef) throw new Error('尚未配置 API 密钥：请先在设置中完成供应商配置')

  const result = await def.execute({ inputs, params, provider, onProgress })
  const images = []
  for (const [index, image] of result.images.entries()) {
    const saved = await saveAsset({ bytes: image.bytes, mime: image.mime, name: `${node.data.type}-${node.id.slice(0, 6)}-${index + 1}` })
    images.push({ assetId: saved.assetId, name: saved.name, bytes: saved.bytes, createdAt: saved.createdAt })
    await attachGalleryMeta(saved.assetId, {
      prompt: String(params.prompt ?? inputs.prompt ?? params.template ?? ''),
      providerName: provider?.name ?? '', model: provider?.model ?? '',
      nodeId: node.id, draftId, at: Date.now()
    })
  }
  const outputs = {}
  for (const port of def.outputs) {
    if (port.kind === 'image') outputs[port.key] = images.map(i => ({ assetId: i.assetId }))
    else outputs[port.key] = result.texts?.[0] ?? null
  }
  return {
    state: 'success',
    error: null,
    lastRun: { at: Date.now(), outputs, usage: result.usage ?? null, images }
  }
}

/** 整画布运行：层级推进，同层并行 ≤4；onNodeState(nodeId, statePatch) 实时回报 */
export async function runWorkflow({ nodes, edges, providers, draftId, onNodeState, shouldStop }) {
  const levels = topoLevels(nodes, edges)
  const nodesById = new Map(nodes.map(n => [n.id, n]))
  const failed = new Set()
  for (const level of levels) {
    if (shouldStop?.()) break
    const runnable = level.filter(id => {
      const node = nodesById.get(id)
      if (!node) return false
      // 下游有失败上游则跳过（标 error 且不执行）
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
      batch.push(executeNode(node, { edges, nodesById, providers, draftId })
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
