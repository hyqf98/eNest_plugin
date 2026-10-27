/**
 * nodeSchema — 节点标准协议的唯一真源。
 *
 * 端口 inputs/outputs
 *   kind 决定连线兼容性与输出标准形态：
 *     text  → string
 *     image → ImageRef[]（{assetId, name?, bytes?, createdAt?}，恒为数组）
 *     json  → 普通对象（变量选择器可下钻）
 *   multiple 作用于输入口：true 合并全部入边，false 只取第一条连线。
 *
 * 参数 params
 *   type 取 PARAM_TYPE 之一，必给 default；acceptsVariable 为 true 时，
 *   运行时先按 {{#nodeId.portKey#}} 插值，再交给 execute。
 *
 * 节点 def
 *   { type, title, glyph, category, description, protocol, runnable, inputs, outputs, params, execute }
 *   runnable 显式声明可否单节点运行，与 protocol（是否走网络）解耦。
 *   execute(ctx) 返回 { outputs: { [portKey]: value }, usage? }。
 */

export const PORT_KIND = { TEXT: 'text', IMAGE: 'image', JSON: 'json' }

export const PORT_KINDS = {
  text: { label: '文本', glyph: '文' },
  image: { label: '图片', glyph: '图' },
  json: { label: '对象', glyph: '物' }
}

export const PARAM_TYPE = {
  TEXTAREA: 'textarea',
  TEXT: 'text',
  NUMBER: 'number',
  SELECT: 'select',
  SLIDER: 'slider',
  SWITCH: 'switch',
  IMAGE: 'image'
}

export function isPortKind(kind) { return Object.hasOwn(PORT_KINDS, kind) }

export function portGlyph(kind) { return PORT_KINDS[kind]?.glyph ?? '?' }

export function findPort(ports, key) {
  if (!key) return null
  return (ports ?? []).find(p => p.key === key) ?? null
}

/** 端口兼容表：未来放宽类型（如 text → json 隐式包装）只需改这里 */
export function compatibleKinds(outputKind, inputKind) {
  if (!outputKind || !inputKind) return false
  return outputKind === inputKind
}

/**
 * 连线候选匹配：源输出端口 → 目标节点可接的输入端口。
 * 返回 { port } 或 null。无输入口的节点（起点）不可作为下游候选：
 * React Flow 没有 handle 就画不出边，连线只认真实端口。
 */
export function matchInputPort(sourcePort, targetDef) {
  if (!sourcePort || !targetDef) return null
  for (const port of targetDef.inputs) {
    if (compatibleKinds(sourcePort.kind, port.kind)) return { port }
  }
  return null
}

/** 目标输入口可行的来源：源节点须有真实端口能喂进它（终点节点不可作上游候选） */
export function matchOutputToTarget(targetPort, sourceDef) {
  if (!targetPort || !sourceDef) return null
  for (const port of sourceDef.outputs) {
    if (compatibleKinds(port.kind, targetPort.kind)) return { port }
  }
  return null
}

/** 参数的一行摘要（卡片折叠态与选择器提示用） */
export function summarizeParam(param, value) {
  if (value == null || value === '') return null
  if (param?.type === PARAM_TYPE.SELECT) {
    return param.options?.find(o => o.value === value)?.label ?? String(value)
  }
  if (param?.type === PARAM_TYPE.IMAGE) return value.assetId ? '已选择' : null
  if (typeof value === 'string') return value.length > 30 ? `${value.slice(0, 30)}…` : value
  return String(value)
}

/** 参数缺省值：只认 def 已声明的键，overrides 里的空值不覆盖 */
export function defaultParams(def, overrides = {}) {
  const out = {}
  for (const param of def?.params ?? []) if (param.default !== undefined) out[param.key] = param.default
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined || value === null || value === '') continue
    if ((def?.params ?? []).some(param => param.key === key)) out[key] = value
  }
  return out
}

/**
 * 输出归一化：把 execute 的返回值收敛到端口标准形态。
 * 图片保持元素原样（未落盘项仍是 {bytes,mime}，由执行器替换为 assetId 引用）。
 */
export function normalizeOutput(port, value) {
  if (!port) return value ?? null
  if (port.kind === PORT_KIND.IMAGE) {
    const list = (Array.isArray(value) ? value : (value ? [value] : [])).filter(Boolean)
    return port.multiple === false ? list.slice(0, 1) : list
  }
  if (port.kind === PORT_KIND.TEXT) {
    if (value == null) return null
    if (Array.isArray(value)) {
      const first = value.find(item => item != null)
      return first == null ? null : String(first)
    }
    return String(value)
  }
  return value ?? null
}

/** 结构校验：返回问题清单（空数组即合法） */
export function validateNodeDef(def) {
  const problems = []
  if (!def?.type) problems.push('缺少 type')
  if (!def?.title) problems.push('缺少 title')
  if (!Array.isArray(def?.inputs)) problems.push('inputs 必须是数组')
  if (!Array.isArray(def?.outputs)) problems.push('outputs 必须是数组')
  if (typeof def?.execute !== 'function') problems.push('缺少 execute(ctx)')

  for (const side of ['inputs', 'outputs']) {
    const seen = new Set()
    for (const port of def?.[side] ?? []) {
      if (!port?.key) { problems.push(`${side} 存在缺 key 的端口`); continue }
      if (seen.has(port.key)) problems.push(`${side} 端口 key 重复：${port.key}`)
      seen.add(port.key)
      if (!isPortKind(port?.kind)) problems.push(`${side}.${port.key} 的 kind 非法：${port?.kind}`)
    }
  }

  const seenParams = new Set()
  for (const param of def?.params ?? []) {
    if (!param?.key) { problems.push('params 存在缺 key 的项'); continue }
    if (seenParams.has(param.key)) problems.push(`params key 重复：${param.key}`)
    seenParams.add(param.key)
    if (!Object.values(PARAM_TYPE).includes(param?.type)) problems.push(`params.${param.key} 的 type 非法：${param?.type}`)
    if (param?.type === PARAM_TYPE.SELECT && !Array.isArray(param.options)) problems.push(`params.${param.key} 为 select 但缺少 options`)
    if (param?.default === undefined) problems.push(`params.${param.key} 缺少 default`)
  }
  return problems
}

/** 节点定义包装：补默认字段并断言结构合法，非法定义在开发期直接抛错 */
export function defineNode(def) {
  const problems = validateNodeDef(def)
  if (problems.length) throw new Error(`节点 ${def?.type ?? '(未知)'} 定义不合法：${problems.join('；')}`)
  return {
    category: '其他',
    description: '',
    protocol: null,
    runnable: true,
    ...def,
    inputs: def.inputs ?? [],
    outputs: def.outputs ?? [],
    params: def.params ?? []
  }
}

let nodeSeq = 0

/**
 * 节点实例的唯一工厂：React Flow 节点壳 + 标准 data 结构。
 * React Flow 的 node.type 恒为 'registry'，业务类型放在 data.type。
 */
export function createNodeData(def, { params, ...overrides } = {}) {
  if (!def) throw new Error('createNodeData 需要已注册的节点定义')
  return {
    type: def.type,
    params: { ...defaultParams(def), ...(params ?? {}) },
    state: 'idle',
    error: null,
    warnings: [],
    lastRun: null,
    ...overrides
  }
}

export function nextNodeId() {
  nodeSeq += 1
  return `n${Date.now().toString(36)}${nodeSeq.toString(36)}`
}
