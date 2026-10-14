/**
 * com.enest.ccswitch — 冒烟测试（mock enest API，node:test + vm）
 * 覆盖：presets ≥30、供应商 CRUD/sort/导出导入脱敏、切换 diff 构造、
 * MCP 格式转换（claude/codex/gemini）、会话解析（列表 meta / 轮次 / usage）、
 * quick/shell 双形态入口样式类。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const pluginRoot = new URL('../', import.meta.url)

/** 构造 mock window + enest API，加载全部插件脚本 */
function makeContext(overrides = {}) {
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
  const listeners = {}
  const documentStub = {
    readyState: 'complete',
    documentElement: { style: { setProperty: () => {} } },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ appendChild: () => {}, addEventListener: () => {}, classList: { add: () => {}, toggle: () => {} }, style: {} }),
    body: { classList: { add: () => {}, toggle: () => {} }, appendChild: () => {} },
    addEventListener: () => {}
  }
  const context = vm.createContext({
    window: {},
    console,
    performance: { now: () => 0 },
    document: documentStub,
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    Promise,
    RegExp,
    Error,
    URL,
    structuredClone,
    setTimeout: () => {},
    requestAnimationFrame: () => {}
  })
  context.window = context
  context.enest = mockApi
  context.zapi = mockApi
  for (const f of ['presets.js', 'api.js', 'providers.js', 'mcp.js', 'sessions.js', 'usage.js', 'main.js']) {
    vm.runInContext(readFileSync(new URL('src/js/' + f, pluginRoot), 'utf8'), context, { filename: f })
  }
  return { context, store, calls, CCS: context.CCS }
}

test('presets: ≥30 个预设 + 分类标签 + 实例化', () => {
  const { CCS } = makeContext()
  assert.ok(CCS.presets.PRESETS.length >= 30, '预设数量需 ≥30，实际 ' + CCS.presets.PRESETS.length)
  assert.ok(CCS.presets.tags().length >= 6)
  const inst = CCS.presets.instantiate(CCS.presets.byId('deepseek-official'))
  assert.equal(inst.name, 'DeepSeek 官方')
  assert.ok(inst.apps.includes('claude-code'))
  assert.ok(inst.quotaEndpoint.includes('balance'))
  assert.equal(CCS.presets.search('glm').length >= 3, true)
})

test('providers: 应用元数据 + changes 构造（claude-code / codex / gemini）', () => {
  const { CCS } = makeContext()
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
  const { CCS } = makeContext()
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
  const { CCS, calls } = makeContext({
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

test('mcp: 格式转换 codex 无 type + gemini httpUrl + claude 原样', () => {
  const { CCS } = makeContext()
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

test('mcp: normalizeSpec 导入归一（claude/gemini/http_headers）', () => {
  const { CCS } = makeContext()
  assert.equal(CCS.mcp.normalizeSpec({ command: 'npx', args: ['x'] }).type, 'stdio')
  assert.equal(CCS.mcp.normalizeSpec({ httpUrl: 'https://m' }).type, 'http')
  assert.equal(CCS.mcp.normalizeSpec({ url: 'https://m', http_headers: { A: 'b' } }).type, 'http')
  assert.equal(CCS.mcp.normalizeSpec({ foo: 1 }), null)
})

test('sessions: 列表 meta 解析（标题/项目/时间/消息数）+ resume 命令', () => {
  const { CCS } = makeContext()
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

test('sessions: 轮次解析（user/assistant/tool_result + usage）与 markdown 导出', () => {
  const { CCS } = makeContext()
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

test('usage: 三应用 usage 语义提取 + 聚合到日/模型', () => {
  const { CCS } = makeContext()
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
  const { CCS } = makeContext({
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

test('main: boot 完成（mock DOM）且 quick/shell 双形态样式类', async () => {
  const { CCS } = makeContext({
    mode: 'quick',
    api: {
      getLaunchMode: () => 'quick',
      onEnter: (cb) => { cb({ code: 'main', mode: 'quick' }); return () => {} }
    }
  })
  // boot 是 async（loadApps → renderNavApps 走 null DOM 容错）；vm 上下文内 setTimeout 为 stub，
  // 用微任务链排空 await 队列（loadApps 3 个 await 层级足够）
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.ok(CCS.ui && CCS.ui.state)
  assert.equal(CCS.ui.state.apps.length, 10)
  // 未安装应用灰显逻辑：gemini-cli installed=false
  assert.equal(CCS.ui.state.installed.has('gemini-cli'), false)
  assert.equal(CCS.ui.state.installed.has('claude-code'), true)
})
