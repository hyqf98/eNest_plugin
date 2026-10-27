/**
 * nodeRegistry — 节点标准协议。
 * 每个节点类型 = { type, title, glyph, category, inputs[], outputs[], params[], execute }
 * - inputs/outputs：端口（kind: text|image|mask），决定连线校验与数据流向
 * - params：声明式表单 schema（节点卡内渲染），type: textarea|text|select|slider|switch
 * - execute(ctx)：ctx = { inputs(已解析上游输出), params, provider, onProgress }
 *     返回 { images: [{bytes,mime}], texts: [string], usage, revised }
 * 新增节点只需在此 register，画布/表单/执行引擎零改动。
 */

import { getProtocol } from './providers.mjs'

const REGISTRY = new Map()

export function registerNode(def) { REGISTRY.set(def.type, def) }
export function getNodeDef(type) { return REGISTRY.get(type) }
export function listNodeDefs() { return Array.from(REGISTRY.values()) }

const SIZE_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '1024 × 1024 方形', value: '1024x1024' },
  { label: '1536 × 1024 横向', value: '1536x1024' },
  { label: '1024 × 1536 纵向', value: '1024x1536' }
]
const QUALITY_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '低（快）', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高（慢/贵）', value: 'high' }
]

/* —— 文生图 —— */
registerNode({
  type: 'text2image',
  title: '文生图',
  glyph: '✦',
  category: '生成',
  protocol: 'openai-images',
  inputs: [{ key: 'prompt', label: '提示词', kind: 'text', optional: true }],
  outputs: [{ key: 'image', label: '图片', kind: 'image', multiple: true }, { key: 'text', label: '改写提示词', kind: 'text' }],
  params: [
    { key: 'prompt', type: 'textarea', label: '提示词', placeholder: '描述要生成的画面……（连线输入会覆盖此项）', rows: 4 },
    { key: 'size', type: 'select', label: '尺寸', options: SIZE_OPTIONS, default: 'auto' },
    { key: 'quality', type: 'select', label: '质量', options: QUALITY_OPTIONS, default: 'auto' },
    { key: 'n', type: 'slider', label: '数量', min: 1, max: 4, step: 1, default: 1 }
  ],
  async execute({ inputs, params, provider, onProgress }) {
    const prompt = String(inputs.prompt ?? params.prompt ?? '').trim()
    if (!prompt) throw new Error('提示词为空：请在参数或连线上提供')
    const protocol = getProtocol('openai-images')
    const result = await protocol.generate(provider, {
      prompt, size: params.size, quality: params.quality, n: params.n, onProgress
    })
    return { images: result.images, texts: [result.revised].filter(Boolean), usage: result.usage }
  }
})

/* —— 图生图 / 编辑 —— */
registerNode({
  type: 'imageEdit',
  title: '图生图 / 编辑',
  glyph: '✎',
  category: '编辑',
  protocol: 'openai-images',
  inputs: [
    { key: 'image', label: '输入图', kind: 'image', optional: false },
    { key: 'prompt', label: '提示词', kind: 'text', optional: true }
  ],
  outputs: [{ key: 'image', label: '图片', kind: 'image', multiple: true }],
  params: [
    { key: 'prompt', type: 'textarea', label: '编辑指令', placeholder: '要如何修改这张图……（连线输入会覆盖此项）', rows: 3 },
    { key: 'size', type: 'select', label: '尺寸', options: SIZE_OPTIONS, default: 'auto' },
    { key: 'quality', type: 'select', label: '质量', options: QUALITY_OPTIONS, default: 'auto' }
  ],
  async execute({ inputs, params, provider, onProgress }) {
    const images = Array.isArray(inputs.image) ? inputs.image : (inputs.image ? [inputs.image] : [])
    if (!images.length) throw new Error('缺少输入图：请连接上游图片节点或本地上传')
    const prompt = String(inputs.prompt ?? params.prompt ?? '').trim()
    if (!prompt) throw new Error('编辑指令为空')
    const protocol = getProtocol('openai-images')
    const result = await protocol.edit(provider, {
      prompt, images: images.slice(0, 4), size: params.size, quality: params.quality, onProgress
    })
    return { images: result.images, texts: [], usage: result.usage }
  }
})

/* —— 提示词模板 —— */
registerNode({
  type: 'promptTemplate',
  title: '提示词模板',
  glyph: '✐',
  category: '输入',
  protocol: null,
  inputs: [{ key: 'text', label: '文本片段', kind: 'text', optional: true, multiple: true }],
  outputs: [{ key: 'text', label: '文本', kind: 'text' }],
  params: [
    { key: 'template', type: 'textarea', label: '模板', placeholder: '一只{1}风格的{2}……用 {{1}}、{{2}} 引用上游文本，未填用的槽位原样保留', rows: 5, default: '' }
  ],
  async execute({ inputs, params }) {
    const upstream = (Array.isArray(inputs.text) ? inputs.text : (inputs.text ? [inputs.text] : [])).map(String)
    return { images: [], texts: [renderTemplate(params.template, upstream)] }
  }
})

/** 模板渲染：{{n}}（1 起）引用上游第 n 个文本输入；越界/缺失原样保留 */
export function renderTemplate(template, upstreamTexts) {
  return String(template ?? '').replace(/\{\{\s*(\d+)\s*\}\}/g, (raw, num) => {
    const index = Number(num) - 1
    return index >= 0 && index < upstreamTexts.length ? upstreamTexts[index] : raw
  })
}

/** 新节点实例的默认参数 */
export function defaultParams(type) {
  const def = getNodeDef(type)
  const out = {}
  for (const p of def?.params ?? []) if (p.default !== undefined) out[p.key] = p.default
  return out
}
