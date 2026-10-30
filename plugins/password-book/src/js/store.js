/**
 * com.github.eNest.password-book — 密码本存储层
 * 键：pb.entries | pb.categories
 * 安全模型：密码明文永不进入 enest.storage。保存时 vault.set('entry:'+id) 取
 * secretRef 存进条目；storage 只保存元数据（title/site/username/category/notes/
 * strength/时间戳）。读密码经 backend revealSecret（host secret.resolve）；
 * 删除条目同步 vault.remove。demo 模式（window.__preview）返回演示数据。
 */
import { backend, isDemo } from './backend.js'

const api = () => window.enest || window.zapi

const KEY_ENTRIES = 'pb.entries'
const KEY_CATEGORIES = 'pb.categories'

/** 内置分类（不可删除；删除自定义分类时条目归入「默认」） */
export const BUILTIN_CATEGORIES = [
  { id: 'default', name: '默认' },
  { id: 'web', name: '网站' },
  { id: 'dev', name: '开发' },
  { id: 'work', name: '工作' }
]

export const uid = () => 'pb_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

function vaultKey(id) { return 'entry:' + id }

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = String(raw.title || '').trim().slice(0, 128)
  if (!title) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : uid(),
    title,
    site: String(raw.site || '').trim().slice(0, 256),
    username: String(raw.username || '').trim().slice(0, 128),
    secretRef: typeof raw.secretRef === 'string' ? raw.secretRef.slice(0, 512) : '',
    category: String(raw.category || 'default').slice(0, 32) || 'default',
    notes: String(raw.notes || '').slice(0, 1024),
    strength: ['weak', 'fair', 'strong'].includes(raw.strength) ? raw.strength : 'weak',
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now()
  }
}

function normalizeCategory(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.name || '').trim().slice(0, 32)
  if (!name) return null
  return { id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 32) : uid(), name }
}

const listeners = new Set()
function notify(event) { for (const listener of listeners) listener(event) }
export function onChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/* —— demo 演示数据（截图环境；secretRef 为假引用，写操作仅更新内存） —— */
const NOW = Date.parse('2026-10-30T10:00:00+08:00') || Date.now()
function demoState() {
  const entries = [
    { title: 'GitHub', site: 'github.com', username: 'haijun@work.dev', category: 'dev', strength: 'strong', secretRef: 'sv:demo:github', notes: '工作主账号，开启 2FA（TOTP）。', createdAt: NOW - 86400_000 * 210, updatedAt: NOW - 86400_000 * 9 },
    { title: 'Gitee', site: 'gitee.com', username: 'haijun', category: 'dev', strength: 'fair', secretRef: 'sv:demo:gitee', notes: '', createdAt: NOW - 86400_000 * 180, updatedAt: NOW - 86400_000 * 46 },
    { title: '阿里云', site: 'account.aliyun.com', username: 'hiJu_cloud', category: 'work', strength: 'strong', secretRef: 'sv:demo:aliyun', notes: 'RAM 主账号，MFA 绑定手机。', createdAt: NOW - 86400_000 * 320, updatedAt: NOW - 86400_000 * 21 },
    { title: '公司 Wiki', site: 'wiki.enest.dev', username: 'haijun', category: 'work', strength: 'weak', secretRef: 'sv:demo:wiki', notes: '季度初强制改密，下一次 2027-01。', createdAt: NOW - 86400_000 * 90, updatedAt: NOW - 86400_000 * 3 },
    { title: 'NPM', site: 'npmjs.com', username: 'haijun_dev', category: 'dev', strength: 'strong', secretRef: 'sv:demo:npm', notes: '发布用 granular token。', createdAt: NOW - 86400_000 * 260, updatedAt: NOW - 86400_000 * 33 },
    { title: 'Figma', site: 'figma.com', username: 'haijun@work.dev', category: 'web', strength: 'fair', secretRef: 'sv:demo:figma', notes: '', createdAt: NOW - 86400_000 * 150, updatedAt: NOW - 86400_000 * 12 },
    { title: 'Apple ID', site: 'appleid.apple.com', username: 'haijun@icloud.com', category: 'web', strength: 'strong', secretRef: 'sv:demo:apple', notes: '家庭组共享购买。', createdAt: NOW - 86400_000 * 400, updatedAt: NOW - 86400_000 * 58 },
    { title: '华为云 ECS', site: 'console.huaweicloud.com', username: 'haijun_ops', category: 'work', strength: 'fair', secretRef: 'sv:demo:hwcloud', notes: '测试环境控制台。', createdAt: NOW - 86400_000 * 65, updatedAt: NOW - 86400_000 * 5 }
  ].map(normalizeEntry)
  return { entries, categories: BUILTIN_CATEGORIES.map(item => ({ ...item })) }
}

let demoData = null
function demo() {
  if (!demoData) demoData = demoState()
  return demoData
}

/* —— 状态 —— */
let state = { entries: [], categories: [] }
let loaded = false
let loading = null

async function persist(key, value) {
  await api()?.storage?.set?.(key, value)
}

async function persistEntries() {
  if (isDemo()) return
  // 元数据永不包含明文；secretRef 是不透明引用
  await persist(KEY_ENTRIES, state.entries)
}

async function persistCategories() {
  if (isDemo()) return
  await persist(KEY_CATEGORIES, state.categories)
}

export async function load() {
  if (isDemo()) {
    state = demo()
    loaded = true
    notify({ kind: 'loaded' })
    return state
  }
  if (loaded) return state
  if (loading) return loading
  loading = (async () => {
    try {
      const [entriesRaw, categoriesRaw] = await Promise.all([
        api()?.storage?.get?.(KEY_ENTRIES),
        api()?.storage?.get?.(KEY_CATEGORIES)
      ])
      const entries = (Array.isArray(entriesRaw) ? entriesRaw : []).map(normalizeEntry).filter(Boolean)
      const custom = (Array.isArray(categoriesRaw) ? categoriesRaw : []).map(normalizeCategory).filter(Boolean)
      state = { entries, categories: [...BUILTIN_CATEGORIES, ...custom] }
      loaded = true
      notify({ kind: 'loaded' })
      return state
    } finally {
      loading = null
    }
  })()
  return loading
}

export function snapshot() {
  return { entries: state.entries.map(entry => ({ ...entry })), categories: state.categories.map(item => ({ ...item })) }
}

export function findEntry(idOrTitle) {
  const key = String(idOrTitle || '').trim()
  if (!key) return null
  return state.entries.find(entry => entry.id === key)
    || state.entries.find(entry => entry.title === key)
    || null
}

export function categoryLabel(id) {
  return state.categories.find(item => item.id === id)?.name || BUILTIN_CATEGORIES[0].name
}

/**
 * 新建条目。password 明文只走 vault.set，返回的条目仅含 secretRef。
 * strength 由调用方（保存前）传入。
 */
export async function createEntry({ title, site, username, password, category, notes, strength }) {
  const entry = normalizeEntry({ title, site, username, category, notes, strength, secretRef: '' })
  if (!entry) throw new Error('标题不能为空')
  if (!entry.username) throw new Error('用户名不能为空')
  if (typeof password !== 'string' || !password) throw new Error('密码不能为空')
  if (password.length > 256) throw new Error('密码超过最大长度 256')
  if (isDemo()) {
    entry.secretRef = 'sv:demo:' + entry.id.slice(3, 11)
    state.entries.unshift(entry)
    notify({ kind: 'created', entry })
    return entry
  }
  try {
    const result = await api()?.vault?.set?.(vaultKey(entry.id), password)
    entry.secretRef = result?.secretRef || vaultKey(entry.id)
  } catch (error) {
    throw new Error('密码保存到保险库失败：' + (error?.message || error))
  }
  state.entries.unshift(entry)
  await persistEntries()
  notify({ kind: 'created', entry })
  return entry
}

/**
 * 更新条目：不传的字段不动；password 非空则替换 vault 密码（同 key 覆盖写）。
 */
export async function updateEntry(id, patch = {}) {
  const index = state.entries.findIndex(entry => entry.id === id)
  if (index < 0) throw new Error('未找到该条目')
  const current = state.entries[index]
  const next = normalizeEntry({
    ...current,
    ...('title' in patch && patch.title !== undefined ? { title: patch.title } : {}),
    ...('site' in patch && patch.site !== undefined ? { site: patch.site } : {}),
    ...('username' in patch && patch.username !== undefined ? { username: patch.username } : {}),
    ...('category' in patch && patch.category !== undefined ? { category: patch.category } : {}),
    ...('notes' in patch && patch.notes !== undefined ? { notes: patch.notes } : {}),
    strength: patch.strength || current.strength
  })
  if (!next) throw new Error('标题不能为空')
  const password = patch.password
  if (isDemo()) {
    if (typeof password === 'string' && password) next.secretRef = 'sv:demo:' + next.id.slice(3, 11)
    state.entries[index] = next
    notify({ kind: 'updated', entry: next })
    return next
  }
  if (typeof password === 'string' && password) {
    if (password.length > 256) throw new Error('密码超过最大长度 256')
    try {
      const result = await api()?.vault?.set?.(vaultKey(next.id), password)
      next.secretRef = result?.secretRef || vaultKey(next.id)
    } catch (error) {
      throw new Error('密码保存到保险库失败：' + (error?.message || error))
    }
  } else {
    next.secretRef = current.secretRef // 留空 = 不修改
  }
  next.updatedAt = Date.now()
  state.entries[index] = next
  await persistEntries()
  notify({ kind: 'updated', entry: next })
  return next
}

/** 删除条目：同步移除 vault 密码（失败不阻断元数据删除，但上报提示） */
export async function deleteEntry(id) {
  const index = state.entries.findIndex(entry => entry.id === id)
  if (index < 0) throw new Error('未找到该条目')
  const entry = state.entries[index]
  let vaultWarning = ''
  if (!isDemo() && entry.secretRef) {
    try { await api()?.vault?.remove?.(vaultKey(entry.id)) }
    catch (error) { vaultWarning = '保险库密码删除失败：' + (error?.message || error) }
  }
  state.entries.splice(index, 1)
  if (!isDemo()) await persistEntries()
  notify({ kind: 'deleted', entry })
  if (vaultWarning) throw new Error(vaultWarning)
  return entry
}

/* —— 分类管理 —— */
export function builtinCategoryIds() { return BUILTIN_CATEGORIES.map(item => item.id) }

export async function createCategory(name) {
  const item = normalizeCategory({ name })
  if (!item) throw new Error('分类名不能为空')
  if (state.categories.some(category => category.name === item.name)) throw new Error('分类已存在')
  if (isDemo()) {
    state.categories.push(item)
    notify({ kind: 'categories' })
    return item
  }
  state.categories.push(item)
  await persistCategories()
  notify({ kind: 'categories' })
  return item
}

export async function renameCategory(id, name) {
  const item = state.categories.find(category => category.id === id)
  if (!item) throw new Error('未找到该分类')
  if (builtinCategoryIds().includes(id)) throw new Error('内置分类不能重命名')
  const next = normalizeCategory({ name })
  if (!next) throw new Error('分类名不能为空')
  if (state.categories.some(category => category.id !== id && category.name === next.name)) throw new Error('分类名已存在')
  item.name = next.name
  if (!isDemo()) await persistCategories()
  notify({ kind: 'categories' })
  return item
}

export async function deleteCategory(id) {
  if (builtinCategoryIds().includes(id)) throw new Error('内置分类不能删除')
  const index = state.categories.findIndex(category => category.id === id)
  if (index < 0) throw new Error('未找到该分类')
  state.categories.splice(index, 1)
  for (const entry of state.entries) if (entry.category === id) entry.category = 'default'
  if (!isDemo()) { await persistCategories(); await persistEntries() }
  notify({ kind: 'categories' })
}
