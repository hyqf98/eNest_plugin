/**
 * mcp.mjs —— eNest MCP 工具处理器注册
 * handler 键集合必须与 plugin.json contributes.mcpTools 完全一致（宿主注册握手逐一对比，
 * 不符即拒绝），修改两侧时同步增删。业务初始化后、页面可见与否无关地注册一次；
 * MCP 冷启动页面是隐藏的，不能等 onEnter。
 */

import { AiError } from './aiActions.mjs'

const ok = (text, structured, extraContent = []) => ({
  content: [{ type: 'text', text }, ...extraContent],
  ...(structured !== undefined ? { structuredContent: structured } : {}),
})

const err = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })

/** 动作函数 → handler：捕获校验/AiError 为业务失败，其余异常为内部错误文本 */
function wrap(run) {
  return async (args) => {
    try {
      return await run(args || {})
    } catch (error) {
      if (error instanceof AiError) return err(error.message)
      return err(`执行失败：${error?.message || String(error)}`)
    }
  }
}

export function registerDrawboardMcp(actions) {
  const api = window.enest
  if (!api?.mcp?.registerHandlers) return Promise.resolve(false)
  const handlers = {
    capture: wrap(async (args) => {
      const result = await actions.capture(args)
      return { content: result.content, structuredContent: result.structured }
    }),
    'draft.list': wrap(async (args) => {
      const r = actions.listDrafts(args)
      return ok(`共 ${r.drafts.length} 个草稿，活动草稿 ${r.activeId}`, r)
    }),
    'draft.get': wrap(async (args) => {
      const r = actions.getDraft(args)
      return { content: r.content, structuredContent: r.structured }
    }),
    'draft.create': wrap(async (args) => {
      const r = actions.createDraft(args)
      return ok(`已创建草稿「${r.name}」(${r.id})${r.switched ? '并切换为活动草稿' : ''}`, r)
    }),
    'draft.rename': wrap(async (args) => {
      const r = actions.renameDraft(args)
      return ok(`草稿 ${r.id} 已重命名为「${r.name}」`, r)
    }),
    'draft.switch': wrap(async (args) => {
      const r = actions.switchDraft(args)
      return ok(r.unchanged ? `草稿 ${r.activeId} 已是活动草稿` : `已切换活动草稿为 ${r.activeId}`, r)
    }),
    'draft.clear': wrap(async (args) => {
      const r = actions.clearDraft(args)
      return ok(r.cleared ? `已清空草稿 ${r.draftId}（移除 ${r.cleared} 个对象）` : `草稿 ${r.draftId} 本来就是空的`, r)
    }),
    'elements.add': wrap(async (args) => {
      const r = await actions.addElements(args)
      return ok(`已向草稿 ${r.draftId} 添加 ${r.ids.length} 个元素：${r.ids.join(', ')}`, r)
    }),
    'elements.update': wrap(async (args) => {
      const r = actions.updateElements(args)
      const parts = [`已更新 ${r.updated.length} 个元素`]
      if (r.notFound.length) parts.push(`未找到：${r.notFound.join(', ')}`)
      return ok(parts.join('；'), r)
    }),
    'elements.delete': wrap(async (args) => {
      const r = actions.deleteElements(args)
      const parts = [`已删除 ${r.removed} 个元素`]
      if (r.notFound > 0) parts.push(`${r.notFound} 个 id 未找到`)
      return ok(parts.join('；'), r)
    }),
    'history.undo': wrap(async (args) => {
      const r = actions.undo(args)
      return ok(r.undone ? '已撤销' : (r.note || '无可撤销操作'), r)
    }),
    'history.redo': wrap(async (args) => {
      const r = actions.redo(args)
      return ok(r.redone ? '已重做' : (r.note || '无可重做操作'), r)
    }),
  }
  return api.mcp.registerHandlers(handlers).then(() => true)
}
