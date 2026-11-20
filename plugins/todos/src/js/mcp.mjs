/**
 * mcp.mjs —— 待办清单 MCP 工具处理器注册
 * handler 键集合必须与 plugin.json contributes.mcpTools 完全一致（宿主注册握手
 * 逐一对比，不符即拒绝）。App 数据就绪（ready）后注册一次、不等页面可见：
 * MCP 冷启动页面是隐藏的，不能等 onEnter。
 * handler 全部走 App 内构造的 api 对象（复用现有 mutation + persist 路径：
 * checkpoint / saveNow / patchTask / toggle / removeTask），不绕过撤销快照机制。
 */
const PRIORITIES = ['normal', 'high', 'low']
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/

const ok = (text, structured) => ({
  content: [{ type: 'text', text }],
  ...(structured !== undefined ? { structuredContent: structured } : {})
})

const err = (message) => ({ isError: true, content: [{ type: 'text', text: `执行失败：${message}` }] })

/** 参数校验/业务失败与内部异常统一转 isError 文本，绝不弹交互框 */
function wrap(run) {
  return async (args) => {
    try {
      return await run(args || {})
    } catch (error) {
      return err(error?.message || String(error))
    }
  }
}

function reqStr(value, field, max) {
  const text = String(value ?? '').trim().slice(0, max)
  if (!text) throw new Error(`${field} 不能为空`)
  return text
}

function optStr(value, field, max) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim().slice(0, max)
  if (!text) throw new Error(`${field} 参数无效`)
  return text
}

/** 标签入参：schema 声明 string[]，容错接受逗号分隔字符串 */
function optTags(value) {
  if (value === undefined || value === null) return undefined
  const raw = Array.isArray(value) ? value : String(value).split(/[,，]/)
  const tags = [...new Set(raw.map(tag => String(tag).trim().slice(0, 64)).filter(Boolean))].slice(0, 16)
  return tags
}

function optDue(value) {
  if (value === undefined || value === null || value === '') return ''
  const due = String(value).trim()
  if (!DUE_RE.test(due)) throw new Error('due 需为 YYYY-MM-DD 格式')
  return due
}

function optPriority(value) {
  if (value === undefined || value === null) return undefined
  if (!PRIORITIES.includes(value)) throw new Error(`priority 仅支持 ${PRIORITIES.join(' / ')}`)
  return value
}

function intArg(value, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || Math.floor(n) !== n) throw new Error('数值参数无效')
  return Math.max(min, Math.min(n, max))
}

export function registerTodosMcp(api) {
  const host = window.enest || window.zapi
  if (!host?.mcp?.registerHandlers) return Promise.resolve(false)
  const handlers = {
    'tasks.list': wrap(async (args) => {
      const r = api.listTasks({
        list: optStr(args.list, 'list', 50),
        done: args.done === undefined || args.done === null ? undefined : Boolean(args.done),
        tags: optTags(args.tags),
        keyword: optStr(args.keyword, 'keyword', 200),
        includeArchived: args.includeArchived === true,
        limit: intArg(args.limit, { min: 1, max: 1000, fallback: 200 })
      })
      return ok(`共 ${r.total} 条任务，返回 ${r.tasks.length} 条${r.truncated ? '（已截断，可用 limit 调大）' : ''}`, r)
    }),
    'task.add': wrap(async (args) => {
      const patch = {
        text: reqStr(args.text, 'text', 500)
      }
      if (args.due !== undefined) patch.due = optDue(args.due)
      if (args.priority !== undefined) patch.priority = optPriority(args.priority)
      if (args.list !== undefined) patch.list = optStr(args.list, 'list', 50)
      const tags = optTags(args.tags)
      if (tags) patch.tags = tags
      if (args.note !== undefined && args.note !== null) patch.note = String(args.note).slice(0, 2000)
      const t = api.addTask(patch)
      return ok(`已添加任务「${t.text}」(${t.id})`, t)
    }),
    'task.update': wrap(async (args) => {
      const id = reqStr(args.id, 'id', 64)
      const patch = {}
      if (args.text !== undefined) patch.text = reqStr(args.text, 'text', 500)
      if (args.due !== undefined) patch.due = optDue(args.due)
      if (args.priority !== undefined) patch.priority = optPriority(args.priority)
      if (args.list !== undefined) patch.list = optStr(args.list, 'list', 50)
      const tags = optTags(args.tags)
      if (tags) patch.tags = tags
      if (args.note !== undefined && args.note !== null) patch.note = String(args.note).slice(0, 2000)
      if (args.pinned !== undefined) patch.pinned = Boolean(args.pinned)
      if (args.archived !== undefined) patch.archived = Boolean(args.archived)
      if (!Object.keys(patch).length) throw new Error('至少提供 text/due/priority/list/tags/note/pinned/archived 之一')
      const t = api.updateTask(id, patch)
      return ok(`已更新任务「${t.text}」(${t.id})`, t)
    }),
    'task.toggle': wrap(async (args) => {
      const id = reqStr(args.id, 'id', 64)
      const done = args.done === undefined || args.done === null ? undefined : Boolean(args.done)
      const t = api.toggleTask(id, done)
      return ok(t.changed ? `任务「${t.text}」已标记为${t.done ? '完成' : '未完成'}` : `任务「${t.text}」已是${t.done ? '完成' : '未完成'}状态`, t)
    }),
    'task.delete': wrap(async (args) => {
      const id = reqStr(args.id, 'id', 64)
      const t = api.deleteTask(id)
      return ok(`已删除任务「${t.text}」（可在界面撤销）`, { id: t.id })
    }),
    'lists.list': wrap(async () => {
      const r = api.listLists()
      return ok(`共 ${r.lists.length} 个清单`, r)
    }),
    'list.add': wrap(async (args) => {
      const name = reqStr(args.name, 'name', 50)
      const r = api.addList(name)
      return ok(r.existed ? `清单「${r.name}」已存在` : `已创建清单「${r.name}」`, r)
    }),
    'list.rename': wrap(async (args) => {
      const from = reqStr(args.from, 'from', 50)
      const to = reqStr(args.to, 'to', 50)
      const r = api.renameList(from, to)
      return ok(`清单「${from}」已重命名为「${to}」，${r.moved} 条任务随迁`, r)
    }),
    'list.delete': wrap(async (args) => {
      const name = reqStr(args.name, 'name', 50)
      const r = api.deleteList(name)
      return ok(`已删除清单「${name}」，${r.moved} 条任务移入「收件箱」`, r)
    })
  }
  return host.mcp.registerHandlers(handlers).then(() => true)
}
