/**
 * 图片预览 — 终点：把上游图片动态渲染在节点里（悬停放大），可选择一张作为终稿。
 * 无输出口，等价 Dify 的 End 节点。
 */
import { defineNode, PORT_KIND } from '../nodeSchema.mjs'
import { registerNode } from '../nodeRegistry.mjs'

registerNode(defineNode({
  type: 'imageOutput',
  title: '图片预览',
  glyph: '▣',
  category: '输出',
  description: '预览上游图片，悬停放大',
  protocol: null,
  runnable: true,
  inputs: [{ key: 'image', label: '图片', kind: PORT_KIND.IMAGE, optional: false, multiple: true }],
  outputs: [],
  params: [],
  async execute({ inputs }) {
    const images = Array.isArray(inputs.image) ? inputs.image : (inputs.image ? [inputs.image] : [])
    if (!images.length) throw new Error('缺少输入图：请连接上游图片节点')
    // 无输出端口：终稿图片走 display（纯展示，不进入数据流）
    return { outputs: {}, display: { images } }
  }
}))
