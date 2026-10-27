/**
 * 图生图 / 编辑 — 图片 + 指令 → 图片。
 * 旧草稿的 data.localImage 由执行器兜底注入 image 输入口。
 */
import { defineNode, PORT_KIND, PARAM_TYPE } from '../nodeSchema.mjs'
import { registerNode } from '../nodeRegistry.mjs'
import { getProtocol } from '../providers.mjs'
import { IMAGE_SIZE_OPTIONS, IMAGE_QUALITY_OPTIONS } from './imageGen.mjs'

registerNode(defineNode({
  type: 'imageEdit',
  title: '图生图 / 编辑',
  glyph: '✎',
  category: '编辑',
  description: '按指令修改输入图',
  protocol: 'openai-images',
  runnable: true,
  inputs: [
    { key: 'image', label: '输入图', kind: PORT_KIND.IMAGE, optional: false, multiple: true },
    { key: 'prompt', label: '提示词', kind: PORT_KIND.TEXT, optional: true }
  ],
  outputs: [{ key: 'image', label: '图片', kind: PORT_KIND.IMAGE, multiple: true }],
  params: [
    { key: 'prompt', type: PARAM_TYPE.TEXTAREA, label: '编辑指令', rows: 3, acceptsVariable: true, default: '' },
    { key: 'size', type: PARAM_TYPE.SELECT, label: '尺寸', options: IMAGE_SIZE_OPTIONS, default: 'auto' },
    { key: 'quality', type: PARAM_TYPE.SELECT, label: '质量', options: IMAGE_QUALITY_OPTIONS, default: 'auto' }
  ],
  async execute({ inputs, params, provider, onProgress }) {
    const images = Array.isArray(inputs.image) ? inputs.image : (inputs.image ? [inputs.image] : [])
    if (!images.length) throw new Error('缺少输入图：请连接上游图片节点或本地上传')
    const prompt = String(inputs.prompt ?? params.prompt ?? '').trim()
    if (!prompt) throw new Error('编辑指令为空')
    const result = await getProtocol('openai-images').edit(provider, {
      prompt, images: images.slice(0, 4), size: params.size, quality: params.quality, onProgress
    })
    return { outputs: { image: result.images }, usage: result.usage }
  }
}))
