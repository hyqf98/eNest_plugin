/**
 * com.enest.ccswitch — 供应商模型与切换语义
 * 应用元数据：10 应用 + 切换式/共存式 + 各应用 changes 构造器（对齐 cc-switch provider 适配层语义）。
 * 供应商 store：storage.local 持久化；顺序、默认供应商、通用供应商。
 * 命名空间挂 window.CCS.providers。
 */
;(function (global) {
  const A = global.CCS.api

  /* —— 应用元数据（app id 对齐宿主 agentConfigService AGENT_ADAPTERS）—— */
  const APPS = [
    { id: 'claude-code', name: 'Claude Code', mode: 'switch', color: '#d97757' },
    { id: 'claude-desktop', name: 'Claude Desktop', mode: 'switch', color: '#b7828e' },
    { id: 'codex', name: 'Codex CLI', mode: 'switch', color: '#10a37f' },
    { id: 'gemini-cli', name: 'Gemini CLI', mode: 'switch', color: '#4285f4' },
    { id: 'grok-build', name: 'Grok Build', mode: 'switch', color: '#666' },
    { id: 'opencode', name: 'OpenCode', mode: 'additive', color: '#8b5cf6' },
    { id: 'openclaw', name: 'OpenClaw', mode: 'additive', color: '#f59e0b' },
    { id: 'hermes', name: 'Hermes', mode: 'switch', color: '#0ea5e9' },
    { id: 'pi', name: 'Pi', mode: 'switch', color: '#84cc16' },
    { id: 'minimax-code', name: 'MiniMax Code', mode: 'switch', color: '#ef4444' }
  ]
  const APP_MAP = Object.fromEntries(APPS.map(a => [a.id, a]))

  /* —— changes 构造器：供应商（名称/端点/key/模型）→ 应用配置顶层键 —— */

  /** claude-code：settings.json env 覆盖型（ANTHROPIC_BASE_URL / AUTH_TOKEN / MODEL） */
  function changesForClaudeCode(p) {
    const env = {}
    if (p.baseUrl) env.ANTHROPIC_BASE_URL = p.baseUrl
    if (p.apiKeyEnv && p.secretRef) env[p.apiKeyEnv] = '${SECRET}' // 由 apply 时替换
    if (p.model) env.ANTHROPIC_MODEL = p.model
    return { env: { ...(p.extraEnv || {}), ...env } }
  }
  /** claude-desktop：claude_desktop_config.json 无供应商语义（仅 MCP），返回 null 表示不支持 */
  function changesForClaudeDesktop() { return null }

  /** codex：config.toml 顶层 model/model_provider + [model_providers.custom] */
  function changesForCodex(p) {
    const changes = {}
    if (p.model) changes.model = p.model
    changes.model_providers = {
      custom: {
        name: p.name || 'custom',
        base_url: p.baseUrl || '',
        env_key: p.envKey || 'OPENAI_API_KEY'
      }
    }
    return changes
  }
  /** codex auth.json：OPENAI_API_KEY（$file 指定） */
  function changesForCodexAuth() { return { $file: 'auth.json' } }

  /** gemini-cli：settings.json 顶层 env（GOOGLE_GEMINI_BASE_URL 等） */
  function changesForGemini(p) {
    const env = {}
    if (p.baseUrl) env.GOOGLE_GEMINI_BASE_URL = p.baseUrl
    if (p.model) env.GEMINI_MODEL = p.model
    return { env: { ...(p.extraEnv || {}), ...env } }
  }
  /** grok-build：config.toml 顶层键（base_url / api_key env / model） */
  function changesForGrok(p) {
    const out = {}
    if (p.baseUrl) out.base_url = p.baseUrl
    if (p.model) out.model = p.model
    return out
  }
  /** opencode：opencode.json provider 段（additive：并入 model.provider 数组） */
  function changesForOpencode(p) {
    return {
      provider: {
        [slug(p.name || 'custom')]: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: p.baseUrl || '' },
          models: p.model ? { [p.model]: { name: p.model } } : {}
        }
      }
    }
  }
  /** openclaw / pi / minimax-code / hermes：JSON/YAML 顶层 env 或 provider 段 */
  function changesForGenericJson(p) {
    const out = {}
    if (p.baseUrl) out.baseUrl = p.baseUrl
    if (p.model) out.model = p.model
    return { provider: out }
  }

  function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'custom'
  }

  /** 各应用的 changes 构造器表；null = 该应用不支持供应商切换（如 claude-desktop） */
  const CHANGES_BUILDERS = {
    'claude-code': changesForClaudeCode,
    'claude-desktop': changesForClaudeDesktop,
    codex: changesForCodex,
    'gemini-cli': changesForGemini,
    'grok-build': changesForGrok,
    opencode: changesForOpencode,
    openclaw: changesForGenericJson,
    hermes: changesForGenericJson,
    pi: changesForGenericJson,
    'minimax-code': changesForGenericJson
  }

  /** codex 密钥写入目标（auth.json OPENAI_API_KEY） */
  function secretChangesFor(app, p) {
    if (app === 'codex') {
      return { $file: 'auth.json', OPENAI_API_KEY: p.plainSecret || '' }
    }
    return null
  }

  /* —— 供应商模型 ——
     {
       id, name, tag, baseUrl, model,
       secretRef?,            // vault 引用
       plainSecret?,          // 仅切换瞬间从 vault 取回（内存态）
       apps: ['claude-code', ...],
       extraEnv?,             // 高级：额外 env（JSON 应用）
       tomlExtra?,            // 高级：toml 片段（合并进 changes，仅 toml 应用）
       isDefault?,            // 默认供应商不可删
       universal?             // 通用供应商标记（多应用同步切换）
     }
  */

  const STORE_KEY = 'ccswitch.providers.v1'
  const ORDER_KEY = 'ccswitch.provider-order.v1'

  let providersCache = null
  let orderCache = null

  async function loadProviders() {
    if (!providersCache) {
      providersCache = (await A.storageGet(STORE_KEY, [])) || []
    }
    if (!orderCache) {
      orderCache = (await A.storageGet(ORDER_KEY, [])) || []
    }
    return providersCache
  }

  async function persist() {
    await A.storageSet(STORE_KEY, providersCache || [])
    await A.storageSet(ORDER_KEY, orderCache || [])
  }

  function newId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }

  function sorted() {
    const list = [...(providersCache || [])]
    const rank = new Map((orderCache || []).map((id, i) => [id, i]))
    list.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9) || a.name.localeCompare(b.name))
    return list
  }

  async function upsertProvider(p) {
    await loadProviders()
    if (!p.id) p.id = newId()
    const idx = providersCache.findIndex(x => x.id === p.id)
    if (idx >= 0) providersCache[idx] = p
    else providersCache.push(p)
    if (!orderCache.includes(p.id)) orderCache.push(p.id)
    await persist()
    return p
  }

  async function removeProvider(id) {
    await loadProviders()
    const hit = providersCache.find(x => x.id === id)
    if (!hit) return false
    if (hit.isDefault) throw new Error('默认供应商不可删除')
    // 使用中不可删：由 UI 层检查 current 判定后调用
    providersCache = providersCache.filter(x => x.id !== id)
    orderCache = orderCache.filter(x => x !== id)
    await persist()
    return true
  }

  async function reorder(fromId, toId) {
    await loadProviders()
    const from = orderCache.indexOf(fromId)
    const to = orderCache.indexOf(toId)
    if (from < 0 || to < 0) return
    orderCache.splice(from, 1)
    orderCache.splice(to, 0, fromId)
    await persist()
  }

  /* —— 活跃探测：从 agent.read 比对当前端点/模型 —— */
  function extractCurrent(app, snapshot) {
    /** 返回 { baseUrl?, model? } 供卡片「当前使用」比对 */
    const files = snapshot?.files || []
    const mainParsed = files[0]?.parsed
    if (!mainParsed || typeof mainParsed !== 'object') return null
    const env = mainParsed.env || {}
    switch (app) {
      case 'claude-code':
        return { baseUrl: env.ANTHROPIC_BASE_URL || null, model: env.ANTHROPIC_MODEL || null }
      case 'codex': {
        const mp = mainParsed.model_providers?.custom || {}
        return { baseUrl: mp.base_url || null, model: mainParsed.model || null }
      }
      case 'gemini-cli':
        return { baseUrl: env.GOOGLE_GEMINI_BASE_URL || null, model: env.GEMINI_MODEL || null }
      case 'grok-build':
        return { baseUrl: mainParsed.base_url || null, model: mainParsed.model || null }
      default:
        return { baseUrl: mainParsed.provider?.baseUrl || null, model: mainParsed.model || null }
    }
  }

  /** toml/yaml 应用 agent.read 不回传 parsed：用正则从原文尽力提取（展示级，不参与写） */
  function extractCurrentFromText(app, content) {
    if (!content) return null
    const pick = (re) => { const m = re.exec(content); return m ? m[1].trim().replace(/^["']|["']$/g, '') : null }
    switch (app) {
      case 'codex':
        return { baseUrl: pick(/^base_url\s*=\s*(.+)$/m), model: pick(/^model\s*=\s*(.+)$/m) }
      case 'grok-build':
        return { baseUrl: pick(/^base_url\s*:\s*(.+)$/m), model: pick(/^model\s*:\s*(.+)$/m) }
      case 'hermes':
        return { baseUrl: pick(/^baseUrl\s*:\s*(.+)$/m), model: pick(/^model\s*:\s*(.+)$/m) }
      default:
        return null
    }
  }

  /* —— 切换 diff 预览 —— */
  /** 构造 before/after 字段级 diff（仅 endpoint/key/model 关键字段） */
  function buildDiff(app, provider, snapshot) {
    const builder = CHANGES_BUILDERS[app]
    const changes = builder ? builder(provider) : null
    if (!changes) return null
    const current =
      extractCurrent(app, snapshot) ||
      extractCurrentFromText(app, snapshot?.files?.[0]?.content) ||
      { baseUrl: null, model: null }
    return {
      app,
      changes,
      rows: [
        {
          k: '端点',
          before: current.baseUrl || '（官方默认）',
          after: provider.baseUrl || '（官方默认）',
          changed: (current.baseUrl || '') !== (provider.baseUrl || '')
        },
        {
          k: '模型',
          before: current.model || '（默认）',
          after: provider.model || '（默认）',
          changed: (current.model || '') !== (provider.model || '')
        },
        {
          k: '密钥',
          before: provider.secretRef ? '••••（保险库）' : '（不变）',
          after: provider.secretRef ? '••••（写入配置）' : '（不变）',
          changed: Boolean(provider.secretRef)
        }
      ]
    }
  }

  /** 执行切换：构造 changes → agent.write（confirmed）→ 返回 backupId */
  async function applyProvider(app, provider) {
    const builder = CHANGES_BUILDERS[app]
    if (!builder) throw new Error('该应用不支持供应商切换')
    const changes = builder(provider)
    if (!changes || Object.keys(changes).length === 0) throw new Error('供应商配置为空')
    // 密钥注入：claude-code env 直接带 key；codex 写 auth.json（宿主单文件合并）
    if (app === 'claude-code' && provider.plainSecret) {
      changes.env = changes.env || {}
      changes.env.ANTHROPIC_AUTH_TOKEN = provider.plainSecret
    }
    if (app === 'gemini-cli' && provider.plainSecret) {
      changes.env = changes.env || {}
      changes.env.GOOGLE_API_KEY = provider.plainSecret
    }
    const results = []
    if (app === 'codex' && provider.plainSecret) {
      // 先写 auth.json（宿主按 $file 落对应白名单文件）
      results.push(await A.agentWrite({
        app,
        changes: { $file: 'auth.json', OPENAI_API_KEY: provider.plainSecret },
        confirmed: true
      }))
    }
    // tomlExtra 合并（高级）
    if (provider.tomlExtra && typeof provider.tomlExtra === 'object') {
      Object.assign(changes, provider.tomlExtra)
    }
    results.push(await A.agentWrite({ app, changes, confirmed: true }))
    return results
  }

  /* —— 导入导出（密钥默认脱敏）—— */
  function exportPayload(includeSecretRefs) {
    const list = sorted().map(p => {
      const copy = { ...p }
      delete copy.plainSecret
      if (!includeSecretRefs) delete copy.secretRef
      return copy
    })
    return {
      format: 'enest.ccswitch.providers',
      version: 1,
      exportedAt: new Date().toISOString(),
      providers: list
    }
  }

  async function importPayload(payload, { onConflict = 'skip' } = {}) {
    const list = Array.isArray(payload?.providers) ? payload.providers : []
    let added = 0
    let skipped = 0
    for (const p of list) {
      if (!p || !p.name) { skipped++; continue }
      await loadProviders()
      const dup = providersCache.find(x => x.name === p.name && (!p.baseUrl || x.baseUrl === p.baseUrl))
      if (dup && onConflict === 'skip') { skipped++; continue }
      const item = {
        id: newId(),
        name: p.name,
        tag: p.tag || '',
        baseUrl: p.baseUrl || '',
        model: p.model || '',
        secretRef: p.secretRef || '',
        apps: Array.isArray(p.apps) ? p.apps : [],
        extraEnv: p.extraEnv || null,
        tomlExtra: p.tomlExtra || null,
        universal: Boolean(p.universal)
      }
      providersCache.push(item)
      orderCache.push(item.id)
      added++
    }
    await persist()
    return { added, skipped }
  }

  global.CCS = global.CCS || {}
  global.CCS.providers = {
    APPS, APP_MAP,
    CHANGES_BUILDERS,
    loadProviders, sorted, upsertProvider, removeProvider, reorder,
    extractCurrent, extractCurrentFromText,
    buildDiff, applyProvider, secretChangesFor,
    exportPayload, importPayload
  }
})(window)
