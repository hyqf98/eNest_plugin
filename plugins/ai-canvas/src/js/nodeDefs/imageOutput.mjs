/**
 * 图片输出 — 图终点：收集上游图片做终稿预览，可选择一张作为结果。
 * 无输出口，等价 Dify 的 End 节点。
 */
import { defineNode, PORT_KIND, PARAM_TYPE } from '../nodeSchema.mjs'
import { registerNode } from '../nodeRegistry.mjs'

registerNode(defineNode({
  type: 'imageOutput',
  title: '图片输出',
  glyph: '▣',
  category: '输出',
  description: '标记终稿，大图预览与导出',
  protocol: null,
  runnable: true,
  inputs: [{ key: 'image', label: '图片', kind: PORT_KIND.IMAGE, optional: false, multiple: true }],
  outputs: [],
  params: [
    { key: 'note', type: PARAM_TYPE.TEXT, label: '备注', default: '', placeholder: '可选：给这一稿留个说明' }
  ],
  async execute({ inputs, params }) {
    const images = Array.isArray(inputs.image) ? inputs.image : (inputs.image ? [inputs.image] : [])
    if (!images.length) throw new Error('缺少输入图：请连接上游图片节点')
    // 无输出端口：终稿图片走 display（纯展示，不进入数据流）
    return { outputs: {}, display: { images, note: String(params.note ?? '') } }
  }
}))
