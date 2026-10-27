/**
 * 文生图 — 提示词 → 图片。support 远程图片生成协议。
 */
import { defineNode, PORT_KIND, PARAM_TYPE } from '../nodeSchema.mjs'
import { registerNode } from '../nodeRegistry.mjs'
import { getProtocol } from '../providers.mjs'

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

export const IMAGE_SIZE_OPTIONS = SIZE_OPTIONS
export const IMAGE_QUALITY_OPTIONS = QUALITY_OPTIONS

registerNode(defineNode({
  type: 'text2image',
  title: '文生图',
  glyph: '✦',
  category: '生成',
  description: '用提示词生成图片',
  protocol: 'openai-images',
  runnable: true,
  inputs: [{ key: 'prompt', label: '提示词', kind: PORT_KIND.TEXT, optional: true }],
  outputs: [
    { key: 'image', label: '图片', kind: PORT_KIND.IMAGE, multiple: true },
    { key: 'text', label: '改写提示词', kind: PORT_KIND.TEXT }
  ],
  params: [
    { key: 'prompt', type: PARAM_TYPE.TEXTAREA, label: '提示词', rows: 4, acceptsVariable: true, default: '' },
    { key: 'size', type: PARAM_TYPE.SELECT, label: '尺寸', options: SIZE_OPTIONS, default: 'auto' },
    { key: 'quality', type: PARAM_TYPE.SELECT, label: '质量', options: QUALITY_OPTIONS, default: 'auto' },
    { key: 'n', type: PARAM_TYPE.SLIDER, label: '数量', min: 1, max: 4, step: 1, default: 1 }
  ],
  async execute({ inputs, params, provider, onProgress }) {
    const prompt = String(inputs.prompt ?? params.prompt ?? '').trim()
    if (!prompt) throw new Error('提示词为空：请在参数或连线上提供')
    const result = await getProtocol('openai-images').generate(provider, {
      prompt, size: params.size, quality: params.quality, n: params.n, onProgress
    })
    return {
      outputs: { image: result.images, text: result.revised ?? null },
      usage: result.usage
    }
  }
}))
