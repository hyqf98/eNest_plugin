/**
 * com.github.eNest.ccswitch — 冒烟测试（mock enest API，node:test + ESM import）
 * 覆盖：presets ≥30、供应商 CRUD/sort/导出导入脱敏、切换 diff 构造、
 * MCP 格式转换（claude/codex/gemini）、会话解析（列表 meta / 轮次 / usage）。
 * React 化后业务模块为 ES Module：直接动态 import（api.js 读 window.enest，先挂 mock）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))

/** 构造 mock window + enest API，动态加载全部业务 ES 模块 */
async function makeContext(overrides = {}) {
  const store = new Map()
  const calls = []
  const mockApi = {
    ui: { toast: () => Promise.resolve(true) },
    storage: {
      get: async k => (store.has(k) ? store.get(k) : undefined),
      set: async (k, v) => { store.set(k, v); return true }
    },
    vault: {
      set: async (k, v) => ({ secretRef: 'vault://' + k }),
      has: async () => true,
      remove: async () => true
    },
    agent: {
      apps: async () => overrides.apps ?? [
        { app: 'claude-code', name: 'Claude Code', installed: true, active: true },
        { app: 'codex', name: 'Codex CLI', installed: true, active: true },
        { app: 'gemini-cli', name: 'Gemini CLI', installed: false, active: false }
      ],
      read: async (app) => overrides.snapshots?.[app] ?? {
        app,
        files: [{ path: '/x/settings.json', content: '{}', parsed: {}, exists: true }],
        active: true,
        readAt: Date.now()
      },
      write: async (input) => { calls.push(['agent.write', input]); return { ok: true, app: input.app, written: [], backupId: 'b1' } },
      backups: async () => [],
      restore: async () => true,
      sessions: {
        list: async (app) => overrides.sessionList?.[app] ?? [],
        read: async (input) => overrides.sessionRead?.[input.file] ?? { lines: [], truncated: false, readBytes: 0, bytes: 0 }
      }
    },
    net: { fetch: async () => { throw new Error('no net in test') } },
    settings: { get: async () => undefined, set: async () => true },
    contribute: { registerQuickProvider: async () => ({ ok: true }) },
    clipboard: { writeText: async () => true },
    shell: { saveTextFile: async () => ({ ok: true, path: '/tmp/x' }) },
    onEnter: () => () => {},
    onModeChange: () => () => {},
    getLaunchMode: () => overrides.mode ?? 'shell',
    getThemeTokens: async () => null,
    ui2: null,
    ...overrides.api
  }
  globalThis.window = { enest: mockApi, zapi: mockApi, matchMedia: () => ({ matches: false }) }
  const mod = async (f) => import(pathToFileURL(resolve(pluginRoot, 'src/js/' + f)).href)
  const [presets, api, providers, history, mcp, snapshot, sessions, usage] = await Promise.all([
    mod('presets.js'), mod('api.js'), mod('providers.js'), mod('history.js'),
    mod('mcp.js'), mod('snapshot.js'), mod('sessions.js'), mod('usage.js')
  ])
  return {
    store, calls,
    CCS: {
      presets,
      api,
      providers,
      history: { load: history.loadHistory, record: history.recordHistory, recent: history.recent, clear: history.clearHistory, rollback: history.rollback, LIMIT: history.HISTORY_LIMIT },
      mcp,
      snapshot,
      sessions,
      usage
    }
  }
}

test('presets: ≥30 个预设 + 分类标签 + 实例化', async () => {
  const { CCS } = await makeContext()
  assert.ok(CCS.presets.PRESETS.length >= 30, '预设数量需 ≥30，实际 ' + CCS.presets.PRESETS.length)
  assert.ok(CCS.presets.presetTags().length >= 6)
  const inst = CCS.presets.instantiate(CCS.presets.byId('deepseek-official'))
  assert.equal(inst.name, 'DeepSeek 官方')
  assert.ok(inst.apps.includes('claude-code'))
  assert.ok(inst.quotaEndpoint.includes('balance'))
  assert.equal(CCS.presets.searchPresets('glm').length >= 3, true)
})

test('providers: 应用元数据 + changes 构造（claude-code / codex / gemini）', async () => {
  const { CCS } = await makeContext()
  assert.equal(CCS.providers.APPS.length, 10)
  const claude = CCS.providers.CHANGES_BUILDERS['claude-code']({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', plainSecret: 'sk-1' })
  assert.equal(claude.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com')
  assert.equal(claude.env.ANTHROPIC_MODEL, 'deepseek-chat')
  const codex = CCS.providers.CHANGES_BUILDERS.codex({ name: 'x', baseUrl: 'https://o.example/v1', model: 'gpt-5' })
  assert.equal(codex.model, 'gpt-5')
  assert.equal(codex.model_providers.custom.base_url, 'https://o.example/v1')
  const gemini = CCS.providers.CHANGES_BUILDERS['gemini-cli']({ baseUrl: 'https://g.example' })
  assert.equal(gemini.env.GOOGLE_GEMINI_BASE_URL, 'https://g.example')
  assert.equal(CCS.providers.CHANGES_BUILDERS['claude-desktop']?.({}), null)
})

test('providers: CRUD + 排序 + 导出脱敏 + 导入', async () => {
  const { CCS } = await makeContext()
  await CCS.providers.upsertProvider({ id: '', name: 'A', baseUrl: 'https://a.example', apps: ['claude-code'], secretRef: 'vault://k' })
  await CCS.providers.upsertProvider({ id: '', name: 'B', baseUrl: 'https://b.example', apps: ['codex'] })
  const all = CCS.providers.sorted()
  assert.equal(all.length, 2)
  // 默认供应商不可删
  await CCS.providers.upsertProvider({ ...all[0], isDefault: true })
  await assert.rejects(() => CCS.providers.removeProvider(all[0].id), /默认供应商/)
  // 导出脱敏
  const payload = CCS.providers.exportPayload(false)
  assert.ok(payload.providers.every(p => !('secretRef' in p)))
  assert.ok(payload.providers.every(p => !('plainSecret' in p)))
  // 导入
  const res = await CCS.providers.importPayload({ providers: [{ name: 'C', baseUrl: 'https://c.example' }, { name: 'B', baseUrl: 'https://b.example' }] })
  assert.equal(res.added, 1)
  assert.equal(res.skipped, 1)
  // 重排
  const [a, b] = CCS.providers.sorted()
  await CCS.providers.reorder(b.id, a.id)
  assert.equal(CCS.providers.sorted()[0].name, 'B')
})

test('switch: diff 构造字段级 before/after + apply 走 agent.write', async () => {
  const { CCS, calls } = await makeContext({
    snapshots: {
      'claude-code': {
        app: 'claude-code',
        files: [{ path: '/x/settings.json', content: '', parsed: { env: { ANTHROPIC_BASE_URL: 'https://old.example' } }, exists: true }],
        active: true
      }
    }
  })
  const p = { id: 'p1', name: 'New', baseUrl: 'https://new.example', model: 'm1', plainSecret: 'sk-x', apps: ['claude-code'] }
  const diff = CCS.providers.buildDiff('claude-code', p, CCS.providers.extractCurrent ? null : null) // buildDiff 内部自取 current
  const diff2 = CCS.providers.buildDiff('claude-code', p, {
    files: [{ parsed: { env: { ANTHROPIC_BASE_URL: 'https://old.example' } } }]
  })
  assert.ok(diff2.rows.length >= 3)
  assert.equal(diff2.rows[0].changed, true)
  assert.equal(diff2.rows[0].after, 'https://new.example')
  await CCS.providers.applyProvider('claude-code', p)
  const write = calls.find(c => c[0] === 'agent.write')
  assert.ok(write, 'agent.write 必须被调用')
  assert.equal(write[1].confirmed, true)
  assert.equal(write[1].changes.env.ANTHROPIC_BASE_URL, 'https://new.example')
  assert.equal(write[1].changes.env.ANTHROPIC_AUTH_TOKEN, 'sk-x')
  // codex 双写：auth.json + config.toml
  calls.length = 0
  await CCS.providers.applyProvider('codex', { ...p, plainSecret: 'sk-y' })
  const files = calls.map(c => c[1].changes.$file || 'config.toml')
  assert.ok(files.includes('auth.json'))
  assert.equal(calls.filter(c => c[1].changes.$file === 'auth.json')[0][1].changes.OPENAI_API_KEY, 'sk-y')
})

test('mcp: 格式转换 codex 无 type + gemini httpUrl + claude 原样', async () => {
  const { CCS } = await makeContext()
  const spec = { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer t' } }
  const codex = CCS.mcp.formatSpec('codex', spec)
  assert.equal(codex.url, 'https://mcp.example.com/mcp')
  assert.equal(codex.http_headers.Authorization, 'Bearer t')
  assert.ok(!('type' in codex), 'codex 不写 type')
  const gemini = CCS.mcp.formatSpec('gemini', spec)
  assert.equal(gemini.httpUrl, 'https://mcp.example.com/mcp')
  assert.ok(!('type' in gemini))
  // 真实路径：应用 id → target.format 映射正确
  assert.equal(CCS.mcp.MCP_TARGETS['gemini-cli'].format, 'gemini')
  assert.equal(CCS.mcp.MCP_TARGETS.codex.format, 'codex')
  assert.equal(CCS.mcp.MCP_TARGETS['claude-code'].format, 'claude')
  assert.equal(CCS.mcp.MCP_TARGETS['claude-code'].file, '.claude.json')
  const stdio = { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { T: '1' } }
  const codexStdio = CCS.mcp.formatSpec('codex', stdio)
  assert.equal(codexStdio.command, 'npx')
  assert.deepEqual(codexStdio.args, ['-y', 'x'])
  const claude = CCS.mcp.formatSpec('claude-code', stdio)
  assert.equal(claude.command, 'npx')
  assert.ok(CCS.mcp.TEMPLATES.length >= 8, '模板 ≥8')
})

test('mcp: normalizeSpec 导入归一（claude/gemini/http_headers）', async () => {
  const { CCS } = await makeContext()
  assert.equal(CCS.mcp.normalizeSpec({ command: 'npx', args: ['x'] }).type, 'stdio')
  assert.equal(CCS.mcp.normalizeSpec({ httpUrl: 'https://m' }).type, 'http')
  assert.equal(CCS.mcp.normalizeSpec({ url: 'https://m', http_headers: { A: 'b' } }).type, 'http')
  assert.equal(CCS.mcp.normalizeSpec({ foo: 1 }), null)
})

test('sessions: 列表 meta 解析（标题/项目/时间/消息数）+ resume 命令', async () => {
  const { CCS } = await makeContext()
  const lines = [
    { json: { sessionId: 's-1', cwd: '/Users/x/proj', timestamp: '2026-10-01T08:00:00Z', type: 'user', message: { role: 'user', content: '帮我写个脚本' } } },
    { json: { type: 'assistant', timestamp: '2026-10-01T08:01:00Z', message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: '好的' }], usage: { input_tokens: 10, output_tokens: 20 } } } }
  ]
  const meta = CCS.sessions.parseSessionMeta({ file: 'projects/proj/s-1.jsonl', bytes: 100, modifiedAt: 1, project: '/Users/x/proj' }, lines)
  assert.equal(meta.sessionId, 's-1')
  assert.equal(meta.title, '帮我写个脚本')
  assert.equal(meta.messageCount, 2)
  assert.equal(CCS.sessions.resumeCommand('claude-code', 's-1'), 'claude --resume s-1')
  assert.equal(CCS.sessions.resumeCommand('codex', 's-1'), 'codex resume s-1')
})

test('sessions: 轮次解析（user/assistant/tool_result + usage）与 markdown 导出', async () => {
  const { CCS } = await makeContext()
  const lines = [
    { json: { type: 'user', timestamp: '2026-10-01T08:00:00Z', message: { role: 'user', content: '跑一下测试' } } },
    { json: { type: 'assistant', timestamp: '2026-10-01T08:00:05Z', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100 } } } },
    { json: { type: 'user', timestamp: '2026-10-01T08:00:10Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'all pass', is_error: false }] } } }
  ]
  const turns = CCS.sessions.parseTurns(lines)
  assert.equal(turns.length, 3)
  assert.equal(turns[0].role, 'user')
  assert.equal(turns[1].role, 'assistant')
  assert.equal(turns[1].usage.cacheRead, 100)
  assert.deepEqual(turns[1].toolCalls, ['Bash {"command":"npm test"}'])
  assert.equal(turns[2].role, 'tool')
  const md = CCS.sessions.toMarkdown({ title: 'T', sessionId: 's1', app: 'claude-code', project: '/p', lastActiveAt: 0 }, { turns, truncated: false })
  assert.match(md, /# T/)
  assert.match(md, /跑一下测试/)
  assert.match(md, /tokens: in 5 \/ out 7/)
})

test('usage: 三应用 usage 语义提取 + 聚合到日/模型', async () => {
  const { CCS } = await makeContext()
  // claude
  const u1 = CCS.usage.extractUsage({ json: { type: 'assistant', timestamp: '2026-10-01T08:00:00Z', message: { model: 'claude-x', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 } } } })
  assert.equal(u1.input, 100); assert.equal(u1.cacheRead, 200)
  // codex
  const u2 = CCS.usage.extractUsage({ json: { type: 'event_msg', timestamp: '2026-10-02T09:00:00Z', payload: { type: 'token_count', info: { model: 'gpt-5', total_token_usage: { input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 2, cached_input_tokens: 8 } } } } })
  assert.equal(u2.output, 7); assert.equal(u2.cacheRead, 8)
  // gemini
  const u3 = CCS.usage.extractUsage({ json: { type: 'gemini', timestamp: '2026-10-03T10:00:00Z', model: 'gemini-x', tokens: { input: 30, output: 3, thoughts: 4, cached: 6 } } })
  assert.equal(u3.output, 7); assert.equal(u3.cacheRead, 6)
  assert.equal(CCS.usage.extractUsage({ json: { type: 'user' } }), null)
  assert.equal(CCS.usage.fmtTokens(1500), '1.5K')
  assert.equal(CCS.usage.fmtTokens(2500000), '2.5M')
})

test('usage: aggregate 走 sessions 通道并聚合计数', async () => {
  const { CCS } = await makeContext({
    sessionList: {
      'claude-code': [
        {
          app: 'claude-code', root: '/x', truncated: false,
          files: [{ file: 'projects/p/a.jsonl', path: '/x/projects/p/a.jsonl', bytes: 10, modifiedAt: 1 }]
        }
      ]
    },
    sessionRead: {
      'projects/p/a.jsonl': {
        lines: [
          { json: { type: 'assistant', timestamp: '2026-10-01T08:00:00Z', message: { model: 'claude-x', usage: { input_tokens: 100, output_tokens: 50 } } } },
          { json: { type: 'assistant', timestamp: '2026-10-01T09:00:00Z', message: { model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1 } } } },
          { json: { type: 'assistant', timestamp: '2026-10-02T08:00:00Z', message: { model: 'claude-y', usage: { input_tokens: 10, output_tokens: 5 } } } }
        ],
        truncated: false, readBytes: 100, bytes: 100
      }
    }
  })
  const agg = await CCS.usage.aggregate('claude-code')
  assert.equal(agg.records, 3)
  assert.equal(agg.totals.input, 111)
  assert.equal(agg.days.length, 2)
  assert.equal(agg.models[0].model, 'claude-x')
})

test('providers: 全部 10 应用 changes 生成 + extractCurrent 回读闭环', async () => {
  const { CCS } = await makeContext()
  const prov = { name: 'Test 供应商', baseUrl: 'https://api.test.example/v1', model: 'test-chat', plainSecret: 'sk-loop' }
  // 每个支持切换的应用：changes 生成 → 构造快照 → extractCurrent 回读 baseUrl/model 一致
  const snapshotShapes = {
    'claude-code': (c) => ({ files: [{ parsed: { env: c.env } }] }),
    'gemini-cli': (c) => ({ files: [{ parsed: { env: c.env } }] }),
    codex: (c) => ({ files: [{ parsed: { model: c.model, model_providers: c.model_providers } }] }),
    'grok-build': (c) => ({ files: [{ parsed: { ...c } }] }),
    opencode: (c) => ({ files: [{ parsed: { provider: c.provider } }] }),
    openclaw: (c) => ({ files: [{ parsed: { provider: c.provider } }] }),
    hermes: (c) => ({ files: [{ parsed: { provider: c.provider } }] }),
    pi: (c) => ({ files: [{ parsed: { provider: c.provider } }] }),
    'minimax-code': (c) => ({ files: [{ parsed: { provider: c.provider } }] })
  }
  const supported = Object.keys(snapshotShapes)
  assert.equal(supported.length, 9, '除 claude-desktop 外 9 个应用支持切换')
  assert.equal(CCS.providers.CHANGES_BUILDERS['claude-desktop']({}), null)
  for (const app of supported) {
    const changes = CCS.providers.CHANGES_BUILDERS[app](prov)
    assert.ok(changes && Object.keys(changes).length > 0, app + ' changes 不能为空')
    const snap = snapshotShapes[app](changes)
    const cur = CCS.providers.extractCurrent(app, snap)
    assert.ok(cur, app + ' extractCurrent 应有结果')
    assert.equal(cur.baseUrl, prov.baseUrl, app + ' 端点回读一致')
    assert.equal(cur.model, prov.model, app + ' 模型回读一致')
    // 回读结果必须能与原供应商互相识别（host 级比对语义）
    assert.equal(new URL(cur.baseUrl).host, new URL(prov.baseUrl).host, app + ' host 比对一致')
  }
  // toml 文本兜底回读（codex）
  const fromText = CCS.providers.extractCurrentFromText('codex', 'base_url = "https://t.example/v1"\nmodel = "m-t"\n')
  assert.equal(fromText.baseUrl, 'https://t.example/v1')
  assert.equal(fromText.model, 'm-t')
})

test('providers: 多标签 tagsOf 兼容旧单标签 + applyProvider 密钥写入', async () => {
  const { CCS, calls } = await makeContext()
  // vm 领域数组与宿主原型不同，展开为宿主数组再 deepEqual
  assert.deepEqual([...CCS.providers.tagsOf({ tag: '官方' })], ['官方'])
  assert.deepEqual([...CCS.providers.tagsOf({ tags: ['官方', '常用', '官方'] })], ['官方', '常用'])
  assert.deepEqual([...CCS.providers.tagsOf({})], [])
  // claude-code 明文密钥 → ANTHROPIC_AUTH_TOKEN
  calls.length = 0
  await CCS.providers.applyProvider('claude-code', { name: 'k', baseUrl: 'https://k.example', model: 'm', plainSecret: 'sk-9' })
  const w = calls[0][1]
  assert.equal(w.changes.env.ANTHROPIC_AUTH_TOKEN, 'sk-9')
  // gemini-cli 明文密钥 → GOOGLE_API_KEY
  calls.length = 0
  await CCS.providers.applyProvider('gemini-cli', { name: 'g', baseUrl: 'https://g.example', plainSecret: 'gk-1' })
  assert.equal(calls[0][1].changes.env.GOOGLE_API_KEY, 'gk-1')
  // 不支持的应用：changes 为 null → applyProvider 抛错（无法写入）
  await assert.rejects(() => CCS.providers.applyProvider('claude-desktop', { name: 'x' }))
})

test('history: 记录 / 环形上限 / 回退走 agent.write', async () => {
  const { CCS, calls } = await makeContext()
  const H = CCS.history
  await H.load()
  // 记录 3 条
  for (let i = 0; i < 3; i++) {
    await H.record({ id: 'p' + i, name: 'P' + i, baseUrl: 'https://p' + i + '.example', model: 'm' + i },
      { baseUrl: 'https://old.example', model: 'old' }, ['claude-code'])
  }
  assert.equal(H.recent().length, 3)
  const top = H.recent()[0]
  assert.equal(top.providerName, 'P2')
  assert.equal(top.prevBaseUrl, 'https://old.example')
  assert.equal(top.changed, true)
  // 环形上限
  for (let i = 0; i < 60; i++) {
    await H.record({ id: 'x' + i, name: 'X' + i, baseUrl: '', model: '' }, { baseUrl: 'https://o.example' }, ['codex'])
  }
  assert.ok(H.recent().length <= H.LIMIT, '历史不超过 ' + H.LIMIT + ' 条')
  // 回退：prev 状态构造临时供应商 → agent.write
  calls.length = 0
  const rollbackEntry = { ...top, app: 'claude-code' }
  await H.rollback(rollbackEntry)
  const write = calls.find(c => c[0] === 'agent.write')
  assert.ok(write, '回退必须触发 agent.write')
  assert.equal(write[1].confirmed, true)
  assert.equal(write[1].changes.env.ANTHROPIC_BASE_URL, 'https://old.example')
  assert.equal(write[1].changes.env.ANTHROPIC_MODEL, 'old')
  // 无 prev 状态的记录不可回退
  await assert.rejects(() => H.rollback({ app: 'claude-code', prevName: null, prevBaseUrl: '', prevModel: '' }), /无法回退/)
  // 清空
  await H.clear()
  assert.equal(H.recent().length, 0)
})

test('snapshot: 全量导出（不含密钥明文）+ 覆盖/合并恢复', async () => {
  const { CCS, store } = await makeContext()
  // ESM 模块注册表跨用例共享：先清空共享 storage 与内存缓存，隔离本用例数据
  const P = CCS.providers
  const M = CCS.mcp
  const SNAP = CCS.snapshot
  store.clear()
  CCS.providers.resetProviderCache()
  CCS.mcp.resetMcpCache()
  // 造数据：2 供应商（含 secretRef）+ 1 MCP
  await P.upsertProvider({ id: '', name: 'A', baseUrl: 'https://a.example', apps: ['claude-code'], secretRef: 'vault://k1', tag: '官方' })
  await P.upsertProvider({ id: '', name: 'B', baseUrl: 'https://b.example', apps: ['codex'], tags: ['自建', '常用'] })
  await M.upsertMcp({ id: 'github', name: 'github', spec: { type: 'stdio', command: 'npx', args: ['x'] }, apps: { 'claude-code': true } })
  // 导出
  const payload = await SNAP.exportAll()
  assert.equal(payload.format, 'enest.ccswitch.full')
  assert.equal(payload.scope.secrets, 'excluded')
  assert.equal(payload.data.providers.length, 2)
  assert.equal(payload.data.mcp.length, 1)
  assert.ok(payload.data.providers.every(p => !('plainSecret' in p)))
  // 覆盖恢复：模块缓存置空 → 覆盖写入（覆盖时旧 secretRef 会被清除）→ 重置缓存再读
  P.resetProviderCache(); M.resetMcpCache()
  await SNAP.importAll(payload, { merge: false })
  P.resetProviderCache(); M.resetMcpCache()
  await P.loadProviders()
  const restored = P.sorted()
  assert.equal(restored.length, 2)
  assert.ok(restored.find(p => p.name === 'A' && p.secretRef === 'vault://k1'))
  const mA = await M.loadMcp()
  assert.equal(mA.length, 1)
  // 合并恢复：同名单跳过
  const res = await SNAP.importAll(payload, { merge: true })
  assert.equal(res.providers.added, 0)
  // 旧格式兼容：{providers:[…]}
  const legacy = await SNAP.importAll({ providers: [{ name: 'C', baseUrl: 'https://c.example' }] }, { merge: true })
  assert.equal(legacy.mode, 'legacy')
  assert.equal(legacy.providers.added, 1)
})
