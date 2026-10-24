import { storageGet, storageSet, agentRead, agentWrite } from './api.js'
/**
 * com.github.eNest.ccswitch — MCP 面板
 * 统一 MCP 列表（storage）→ 按应用启用 → 写入对应应用 mcp 位置：
 * - claude-code：~/.claude.json 顶层 mcpServers（agent.write 第二白名单文件，经 $file 指定）
 * - claude-desktop：claude_desktop_config.json 顶层 mcpServers
 * - codex：config.toml [mcp_servers.*]（changes.mcp_servers = { id: {...} }，插件后端拆子表）
 * - gemini-cli：settings.json 顶层 mcpServers（Gemini 格式：http→httpUrl、去 type）
 * - 其余应用：各自配置键（opencode mcp.local 等，best-effort）
 * 语义对齐 cc-switch mcp/{claude,codex,gemini}.rs。命名空间挂 window.CCS.mcp。
 */

const STORE_KEY = 'ccswitch.mcp.v1'

/* —— 常用 MCP 模板（≥8）—— */
const TEMPLATES = [
  { id: 'github', name: 'GitHub', spec: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }, envHint: 'GITHUB_PERSONAL_ACCESS_TOKEN', homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'filesystem', name: 'Filesystem', spec: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] }, homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'fetch', name: 'Fetch', spec: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] }, homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'memory', name: 'Memory', spec: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }, homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'sequential-thinking', name: 'Sequential Thinking', spec: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] }, homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'brave-search', name: 'Brave Search', spec: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] }, envHint: 'BRAVE_API_KEY', homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'puppeteer', name: 'Puppeteer', spec: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] }, homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'context7', name: 'Context7（文档）', spec: { type: 'http', url: 'https://mcp.context7.com/mcp' }, homepage: 'https://context7.com' },
  { id: 'deepwiki', name: 'DeepWiki', spec: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' }, homepage: 'https://deepwiki.com' },
  { id: 'playwright', name: 'Playwright', spec: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, homepage: 'https://github.com/microsoft/playwright-mcp' }
]

/* —— 各应用 MCP 写入位置 —— */
const MCP_TARGETS = {
  'claude-code': { file: '.claude.json', key: 'mcpServers', format: 'claude' },
  'claude-desktop': { file: 'claude_desktop_config.json', key: 'mcpServers', format: 'claude' },
  codex: { key: 'mcp_servers', format: 'codex' },
  'gemini-cli': { key: 'mcpServers', format: 'gemini' },
  opencode: { key: 'mcp', format: 'opencode' },
  'minimax-code': { key: 'mcpServers', format: 'claude' },
  pi: { key: 'mcpServers', format: 'claude' },
  openclaw: { key: 'mcpServers', format: 'claude' },
  hermes: { key: 'mcpServers', format: 'claude' },
  'grok-build': { key: 'mcp_servers', format: 'codex' }
}

/* —— 规范 → 各应用格式 —— */

/** claude 格式：原样（type/command/args/env 或 url），去掉 UI 辅助键 */
function specForClaude(spec) {
  const out = { ...spec }
  delete out.id; delete out.name; delete out.enabled
  return out
}

/** codex 格式：无 type 字段（由 command/url 推断）；http headers → http_headers */
function specForCodex(spec) {
  const out = {}
  if (spec.type === 'http' || spec.type === 'sse') {
    if (spec.url) out.url = spec.url
    if (spec.headers && typeof spec.headers === 'object') {
      out.http_headers = {}
      for (const [k, v] of Object.entries(spec.headers)) out.http_headers[k] = String(v)
    }
  } else {
    if (spec.command) out.command = spec.command
    if (Array.isArray(spec.args) && spec.args.length) out.args = spec.args.map(String)
    if (spec.env && typeof spec.env === 'object') {
      out.env = {}
      for (const [k, v] of Object.entries(spec.env)) out.env[k] = String(v)
    }
    if (spec.cwd) out.cwd = spec.cwd
  }
  return out
}

/** gemini 格式：无 type；http → httpUrl；补 timeout(ms) */
function specForGemini(spec) {
  const out = {}
  if (spec.type === 'http') {
    if (spec.url) out.httpUrl = spec.url
  } else if (spec.type === 'sse') {
    if (spec.url) out.url = spec.url
  } else {
    if (spec.command) out.command = spec.command
    if (Array.isArray(spec.args) && spec.args.length) out.args = spec.args.map(String)
    if (spec.env && typeof spec.env === 'object') {
      out.env = {}
      for (const [k, v] of Object.entries(spec.env)) out.env[k] = String(v)
    }
  }
  out.timeout = 60000
  return out
}

/** opencode 格式：mcp.local.<id>（stdio）/ mcp.remote.<id>（http） */
function specForOpencode(spec) {
  return spec.type === 'http' || spec.type === 'sse'
    ? { type: 'remote', url: spec.url }
    : { type: 'local', command: spec.command, args: spec.args || [], env: spec.env || {} }
}

function formatSpec(format, spec) {
  switch (format) {
    case 'codex': return specForCodex(spec)
    case 'gemini': return specForGemini(spec)
    case 'opencode': return specForOpencode(spec)
    default: return specForClaude(spec)
  }
}

/* —— store —— */
let cache = null

async function load() {
  if (!cache) cache = (await storageGet(STORE_KEY, [])) || []
  return cache
}
async function persist() {
  await storageSet(STORE_KEY, cache || [])
}

/** 清空内存缓存（全量恢复等外部写入 storage 后调用） */
function resetCache() {
  cache = null
}

/** 条目：{ id, name, spec, apps: { appId: true }, homepage? } */
async function upsert(entry) {
  await load()
  const idx = cache.findIndex(x => x.id === entry.id)
  if (idx >= 0) cache[idx] = entry
  else cache.push(entry)
  await persist()
  return entry
}

async function remove(id) {
  await load()
  cache = cache.filter(x => x.id !== id)
  await persist()
}

async function toggleApp(id, appId, on) {
  await load()
  const hit = cache.find(x => x.id === id)
  if (!hit) return
  hit.apps = hit.apps || {}
  hit.apps[appId] = on
  await persist()
}

/** 读某应用现有 mcp 配置（导入用；尽力而为解析） */
function extractFromSnapshot(app, snapshot) {
  const target = MCP_TARGETS[app]
  if (!target) return []
  const files = snapshot?.files || []
  // JSON 应用：定位目标文件（按 file 后缀匹配），取 parsed[key]
  for (const f of files) {
    if (!f.exists || !f.parsed || typeof f.parsed !== 'object') continue
    if (target.file && !f.path.endsWith(target.file)) continue
    const seg = (f.parsed[target.key] || (target.key.includes('.') ? target.key.split('.').reduce((o, k) => (o || {})[k], f.parsed) : null))
    if (seg && typeof seg === 'object') {
      return Object.entries(seg).map(([id, spec]) => ({ id, spec, app }))
    }
  }
  // TOML 应用：原文正则提取 [mcp_servers.<id>] 段（展示级）
  if (target.format === 'codex') {
    const content = files[0]?.content || ''
    const out = []
    const re = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]([^\[]*)/gm
    let m
    while ((m = re.exec(content))) {
      const body = m[2]
      const command = /^command\s*=\s*"(.*)"/m.exec(body)
      const url = /^url\s*=\s*"(.*)"/m.exec(body)
      out.push({
        id: m[1],
        spec: { type: url ? 'http' : 'stdio', command: command?.[1] || '', url: url?.[1] || '' },
        app
      })
    }
    return out
  }
  return []
}

/** 从统一列表提取某应用的 mcpServers map（读改写语义：读现有 → 合并 → 写回） */
async function currentMapForApp(app) {
  const target = MCP_TARGETS[app]
  if (!target) return {}
  try {
    const snapshot = await agentRead(app)
    const existing = extractFromSnapshot(app, snapshot)
    const map = {}
    for (const { id, spec } of existing) {
      // 现有条目按应用格式保留原始形状（写回时不被改写）
      map[id] = spec
    }
    return map
  } catch {
    return {}
  }
}

/** 同步单个应用到其 mcp 位置（enabled 项全量投射；未启用项从目标移除） */
async function syncToApp(app) {
  await load()
  const target = MCP_TARGETS[app]
  if (!target) throw new Error('该应用暂不支持 MCP 同步')
  // 组装启用的条目
  const enabled = {}
  for (const entry of cache) {
    if (entry.apps?.[app]) {
      enabled[entry.id] = formatSpec(target.format, entry.spec)
    }
  }
  // 读取现有（保留非面板管理的条目），合并：面板启用项覆盖同名，其余保留；面板曾管理但现已关掉的条目需移除
  const existing = await currentMapForApp(app)
  const merged = { ...existing }
  const managedIds = new Set(cache.map(e => e.id))
  // 移除本面板管理且未启用此应用的条目
  for (const id of Object.keys(merged)) {
    if (managedIds.has(id) && !enabled[id]) delete merged[id]
  }
  Object.assign(merged, enabled)

  let changes
  if (target.format === 'codex') {
    changes = { mcp_servers: merged }
  } else if (target.format === 'opencode') {
    const local = {}
    const remote = {}
    for (const [id, spec] of Object.entries(merged)) {
      if (spec && (spec.type === 'remote' || spec.url)) remote[id] = spec
      else local[id] = spec
    }
    changes = { mcp: { local, remote } }
  } else {
    changes = { mcpServers: merged }
    if (target.file) changes.$file = target.file
  }
  return agentWrite({ app, changes, confirmed: true })
}

/** 从某应用导入（不覆盖已有，仅新增 + 标记启用该应用） */
async function importFromApp(app) {
  const snapshot = await agentRead(app)
  const found = extractFromSnapshot(app, snapshot)
  await load()
  let added = 0
  for (const { id, spec } of found) {
    const normalized = normalizeSpec(spec)
    if (!normalized) continue
    const existing = cache.find(x => x.id === id)
    if (existing) {
      existing.apps = existing.apps || {}
      existing.apps[app] = true
    } else {
      cache.push({ id, name: id, spec: normalized, apps: { [app]: true } })
      added++
    }
  }
  await persist()
  return { added, total: found.length }
}

/** 各应用原始 spec → 统一规范（stdio/http + command/url） */
function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object') return null
  const out = { type: 'stdio' }
  if (spec.httpUrl) { out.type = 'http'; out.url = spec.httpUrl }
  else if (spec.url) { out.type = spec.command ? 'stdio' : 'http'; if (!spec.command) out.url = spec.url }
  if (spec.command) out.command = spec.command
  if (Array.isArray(spec.args)) out.args = spec.args.map(String)
  if (spec.env && typeof spec.env === 'object') out.env = spec.env
  if (spec.http_headers && typeof spec.http_headers === 'object') {
    out.type = 'http'
    out.headers = spec.http_headers
    if (spec.url) out.url = spec.url
  }
  if (spec.headers && typeof spec.headers === 'object') out.headers = spec.headers
  return out.command || out.url ? out : null
}

export { TEMPLATES, MCP_TARGETS, load as loadMcp, upsert as upsertMcp, remove as removeMcp, toggleApp as toggleMcpApp, resetCache as resetMcpCache, syncToApp, importFromApp, extractFromSnapshot, normalizeSpec, formatSpec }
