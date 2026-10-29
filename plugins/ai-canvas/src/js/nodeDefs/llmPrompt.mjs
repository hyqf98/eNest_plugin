/**
 * LLM 提示词优化 — 系统提示（可改写）+ 用户提示（入边或参数）→ 优化后的提示词。
 * 输出文本支持 markdown 渲染（节点预览与放大弹窗）。protocol 走 openai-chat。
 */
import { defineNode, PORT_KIND, PARAM_TYPE } from '../nodeSchema.mjs'
import { registerNode } from '../nodeRegistry.mjs'
import { getProtocol } from '../providers.mjs'

registerNode(defineNode({
  type: 'llmPrompt',
  title: 'LLM 提示词优化',
  glyph: '☄',
  category: '文本',
  description: '调用大模型把粗略提示词优化为高质量描述',
  protocol: 'openai-chat',
  runnable: true,
  inputs: [{ key: 'prompt', label: '原始提示词', kind: PORT_KIND.TEXT, optional: true }],
  outputs: [{ key: 'text', label: '优化提示词', kind: PORT_KIND.TEXT }],
  params: [
    {
      key: 'system', type: PARAM_TYPE.TEXTAREA, label: '系统提示词', rows: 3, acceptsVariable: true,
      default: '你是资深的 AI 绘画提示词工程师。把用户的粗略描述改写为结构清晰、细节丰富、可直接用于文生图模型的英文提示词：主体、风格、光线、构图、画质关键词依次展开。只输出最终提示词本身，不要解释。',
      expandable: true
    },
    { key: 'prompt', type: PARAM_TYPE.TEXTAREA, label: '用户提示词', rows: 3, acceptsVariable: true, default: '', expandable: true },
    { key: 'temperature', type: PARAM_TYPE.SLIDER, label: '创造性', min: 0, max: 2, step: 0.1, default: 0.7 }
  ],
  async execute({ inputs, params, provider }) {
    const user = String(inputs.prompt ?? params.prompt ?? '').trim()
    if (!user) throw new Error('缺少原始提示词：请填写参数或连接上游文本')
    const result = await getProtocol('openai-chat').complete(provider, {
      system: params.system, user, temperature: Number(params.temperature ?? 0.7)
    })
    return { outputs: { text: result.text }, usage: result.usage }
  }
}))
