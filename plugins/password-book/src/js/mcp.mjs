/**
 * mcp.mjs —— 密码本 MCP 工具处理器注册
 * handler 键集合必须与 plugin.json contributes.mcpTools 完全一致（宿主注册握手
 * 逐一对比，不符即拒绝）。模块加载即注册，不等 onEnter——MCP 冷启动页面是
 * 隐藏的。handler 复用与 UI 相同的 store 层（storage + vault）。
 * demo 模式（window.__preview）下 fixture 的 registerHandlers 是 no-op proxy，
 * 本模块仍可安全加载并注册（不产生真实副作用）。
 */
import { backend, isDemo } from './backend.js'
import * as store from './store.js'

const REF_ONLY = /^sv:/ // 条目内的 ref 不透传给 list 结果

const ok = (text, structured) => ({
  content: [{ type: 'text', text }],
  ...(structured !== undefined ? { structuredContent: structured } : {})
})
const err = (message) => ({ isError: true, content: [{ type: 'text', text: `错误：${message}` }] })

function wrap(run) {
  return async (args) => {
    try {
      return await run(args || {})
    } catch (error) {
      return err(error?.message || String(error))
    }
  }
}

function text(value, max) {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new Error('参数必须是字符串')
  return String(value ?? '').slice(0, max)
}

function requireIdOrTitle(args) {
  const id = text(args.id, 64).trim()
  const title = text(args.title, 128).trim()
  if (!id && !title) throw new Error('请提供 id 或 title 之一')
  const entry = id ? store.findEntry(id) : null
  const target = entry || (title ? store.findEntry(title) : null)
  if (!target) throw new Error(id ? `未找到 id 为 ${id} 的条目` : `未找到标题为「${title}」的条目`)
  return target
}

function publicView(entry) {
  // 绝不含 secretRef 与密码
  const { id, title, site, username, category, notes, strength, updatedAt } = entry
  return { id, title, site, username, category, notes, strength, updatedAt }
}

const handlers = {
  list: wrap(async (args) => {
    await store.load()
    const keyword = text(args.keyword, 64).trim().toLowerCase()
    let entries = store.snapshot().entries
    if (keyword) {
      entries = entries.filter(entry =>
        [entry.title, entry.site, entry.username].some(field => String(field || '').toLowerCase().includes(keyword)))
    }
    entries = [...entries].sort((a, b) => b.updatedAt - a.updatedAt)
    const lines = entries.map((entry, index) =>
      `${index + 1}. ${entry.title}${entry.site ? `（${entry.site}）` : ''} · ${entry.username} · ${entry.category} · 强度 ${entry.strength}`)
    const head = keyword ? `关键词「${keyword}」命中 ${entries.length} 条` : `共 ${entries.length} 条`
    return ok(entries.length ? `${head}：\n${lines.join('\n')}` : `${head}。`, {
      count: entries.length,
      entries: entries.map(publicView)
    })
  }),

  get: wrap(async (args) => {
    await store.load()
    const target = requireIdOrTitle(args)
    if (!target.secretRef || !REF_ONLY.test(target.secretRef)) throw new Error('该条目没有可读取的密码')
    const { secret } = await backend.revealSecret(target.secretRef)
    if (typeof secret !== 'string' || !secret) throw new Error('密码解密失败，请检查系统密钥库')
    const view = publicView(target)
    const textResult = [
      `标题：${view.title}`,
      view.site ? `站点：${view.site}` : '',
      `用户名：${view.username}`,
      `密码：${secret}`,
      `分类：${view.category}`,
      view.notes ? `备注：${view.notes}` : '',
      `强度：${view.strength}`,
      `更新时间：${new Date(view.updatedAt).toLocaleString('zh-CN')}`
    ].filter(Boolean).join('\n')
    return ok(textResult, { ...view, password: secret })
  }),

  create: wrap(async (args) => {
    await store.load()
    const title = text(args.title, 128).trim()
    const username = text(args.username, 128).trim()
    const password = text(args.password, 256)
    if (!title) throw new Error('title 不能为空')
    if (!username) throw new Error('username 不能为空')
    if (!password) throw new Error('password 不能为空')
    if (store.snapshot().entries.some(entry => entry.title === title)) throw new Error(`标题「${title}」已存在，请换一个标题或改用 update`)
    let strength = 'weak'
    try { strength = (await backend.strength(password)).label } catch { /* 打分失败不阻断保存 */ }
    const entry = await store.createEntry({
      title, username, password,
      site: text(args.site, 256).trim(),
      category: text(args.category, 32).trim() || 'default',
      notes: text(args.notes, 1024),
      strength
    })
    return ok(`已创建条目「${entry.title}」（id：${entry.id}），密码已加密存入保险库。`, publicView(entry))
  }),

  update: wrap(async (args) => {
    await store.load()
    const target = requireIdOrTitle(args)
    const patch = {}
    if (args.title !== undefined) {
      const title = text(args.title, 128).trim()
      if (!title) throw new Error('title 不能为空')
      if (store.snapshot().entries.some(entry => entry.id !== target.id && entry.title === title)) throw new Error(`标题「${title}」已被其他条目使用`)
      patch.title = title
    }
    if (args.username !== undefined) {
      const username = text(args.username, 128).trim()
      if (!username) throw new Error('username 不能为空')
      patch.username = username
    }
    if (args.site !== undefined) patch.site = text(args.site, 256).trim()
    if (args.category !== undefined) patch.category = text(args.category, 32).trim() || 'default'
    if (args.notes !== undefined) patch.notes = text(args.notes, 1024)
    if (args.password !== undefined) {
      const password = text(args.password, 256)
      if (!password) throw new Error('password 不能为空；如需清除请改用 delete')
      patch.password = password
      try { patch.strength = (await backend.strength(password)).label } catch { /* 忽略打分失败 */ }
    }
    const next = await store.updateEntry(target.id, patch)
    return ok(`已更新条目「${next.title}」${patch.password ? '（密码已替换）' : ''}。`, publicView(next))
  }),

  delete: wrap(async (args) => {
    await store.load()
    const target = requireIdOrTitle(args)
    await store.deleteEntry(target.id)
    return ok(`已删除条目「${target.title}」，保险库中的密码已同步移除。`, { id: target.id, title: target.title })
  })
}

/** 模块加载即注册（MCP 冷启动页面隐藏，不能等 onEnter）；失败静默，页面加载后可重试 */
export function registerPasswordBookMcp() {
  const api = window.enest || window.zapi
  if (!api?.mcp?.registerHandlers) return Promise.resolve(false)
  return api.mcp.registerHandlers(handlers).then(() => true).catch(() => false)
}

void registerPasswordBookMcp()
