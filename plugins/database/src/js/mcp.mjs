/**
 * mcp.mjs —— eNest MCP 工具处理器注册（数据库）
 * handler 键集合必须与 plugin.json contributes.mcpTools 完全一致（宿主注册握手逐一对比，
 * 不符即拒绝），修改两侧时同步增删。store.loadAll 完成后注册一次；MCP 冷启动页面是
 * 隐藏的，不能等 onEnter。
 *
 * MCP 运行时禁止任何交互：这里绝不触发文件选择器 / 权限弹窗 / 对话框。未授权、
 * 需确认或本地文件句柄缺失等错误原样透传给 AI，由 AI 转述用户处理。
 * 业务体已提取到 tools/dbTools.mjs 的 execTool；此处仅做 ok/err 包装与会话映射
 * （MCP 专用 ::mcp 会话，与界面控制台、AI 助手 ::ai 会话隔离，互不抢占）。
 */

import { execTool, DB_TOOL_IDS } from './tools/dbTools.mjs'

const ok = (text, structured) => ({
  content: [{ type: 'text', text }],
  ...(structured !== undefined ? { structuredContent: structured } : {})
})

const err = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })

/** connectionId -> MCP 专用 sessionKey */
const mcpSessions = new Map()

export function registerDatabaseMcp() {
  const host = window.enest || window.zapi
  if (!host?.mcp?.registerHandlers) return Promise.resolve(false)
  const ctx = { sessions: mcpSessions, suffix: '::mcp' }
  const handlers = {}
  for (const id of DB_TOOL_IDS) {
    handlers[id] = async (args) => {
      try {
        const { text, structured } = await execTool(id, args, ctx)
        return ok(text, structured)
      } catch (error) {
        return err(String(error?.message || error))
      }
    }
  }
  return host.mcp.registerHandlers(handlers).then(() => true)
}
