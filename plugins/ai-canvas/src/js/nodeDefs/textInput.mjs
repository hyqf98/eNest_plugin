/**
 * 文本输入 — 图起点：手动填写文本，无输入口。
 */
import { defineNode, PORT_KIND, PARAM_TYPE } from '../nodeSchema.mjs'
import { registerNode } from '../nodeRegistry.mjs'

registerNode(defineNode({
  type: 'textInput',
  title: '文本输入',
  glyph: 'T',
  category: '文本',
  description: '手工填写一段文本',
  protocol: null,
  runnable: true,
  inputs: [],
  outputs: [{ key: 'text', label: '文本', kind: PORT_KIND.TEXT }],
  params: [
    { key: 'text', type: PARAM_TYPE.TEXTAREA, label: '内容', rows: 4, default: '', placeholder: '在此填写文本，运行后作为下游输入' }
  ],
  async execute({ params }) {
    return { outputs: { text: String(params.text ?? '') } }
  }
}))
