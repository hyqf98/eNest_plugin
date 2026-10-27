/**
 * 本地图片 — 图起点：本机选取/拖入一张图，运行后产出 image 输出。
 * 图片在选择时即落 storage.assets 拿稳定 assetId，节点只记引用。
 */
import { defineNode, PORT_KIND, PARAM_TYPE } from '../nodeSchema.mjs'
import { registerNode } from '../nodeRegistry.mjs'

registerNode(defineNode({
  type: 'localImage',
  title: '本地图片',
  glyph: '▨',
  category: '输入',
  description: '从本机选取一张图片作为输入',
  protocol: null,
  runnable: true,
  inputs: [],
  outputs: [{ key: 'image', label: '图片', kind: PORT_KIND.IMAGE, multiple: true }],
  params: [
    { key: 'image', type: PARAM_TYPE.IMAGE, label: '图片', default: null }
  ],
  async execute({ params }) {
    const ref = params.image
    if (!ref?.assetId) throw new Error('尚未选择图片：请点击参数区的「选择图片」')
    return { outputs: { image: [{ assetId: ref.assetId, name: ref.name }] } }
  }
}))
