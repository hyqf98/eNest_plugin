/**
 * 提示词模板 — 多段文本拼一条提示词。
 * 同时支持 {{n}} 位置槽位（本节点语义）与 {{#nodeId.port#}} 变量引用（全局语义）。
 */
import { defineNode, PORT_KIND, PARAM_TYPE } from '../nodeSchema.mjs'
import { registerNode } from '../nodeRegistry.mjs'

/** 位置槽位：{{n}}（1 起）引用上游第 n 个文本输入；越界/缺失原样保留 */
export function renderTemplate(template, upstreamTexts) {
  return String(template ?? '').replace(/\{\{\s*(\d+)\s*\}\}/g, (raw, num) => {
    const index = Number(num) - 1
    return index >= 0 && index < upstreamTexts.length ? upstreamTexts[index] : raw
  })
}

registerNode(defineNode({
  type: 'promptTemplate',
  title: '提示词模板',
  glyph: '✐',
  category: '文本',
  description: '拼接多段文本为一条提示词',
  protocol: null,
  runnable: true,
  inputs: [{ key: 'text', label: '文本片段', kind: PORT_KIND.TEXT, optional: true, multiple: true }],
  outputs: [{ key: 'text', label: '文本', kind: PORT_KIND.TEXT }],
  params: [
    {
      key: 'template', type: PARAM_TYPE.TEXTAREA, label: '模板', rows: 5, acceptsVariable: true, default: '',
      placeholder: '一只{{1}}风格的{{2}}……用 {{1}}、{{2}} 引用上游文本，或用 {{#节点.端口#}} 引用指定输出'
    }
  ],
  async execute({ inputs, params }) {
    const upstream = (Array.isArray(inputs.text) ? inputs.text : (inputs.text ? [inputs.text] : [])).map(String)
    return { outputs: { text: renderTemplate(params.template, upstream) } }
  }
}))
