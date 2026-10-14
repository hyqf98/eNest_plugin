/**
 * main.js — 网络调试台 · 入口与三模式工作台
 * 依赖：plugin-kit（PluginKit.create / badge / hexDump）、./core.js 纯逻辑
 * 宿主：enest.net.fetch / enest.net.socket / storage / clipboard / ui.toast
 * 结构：
 *   - 会话（Tab）：HTTP / TCP / WebSocket 三种 kind，桌面多会话、Quick 单会话
 *   - HTTP：构建 → 流式发送 → 响应（JSON 树 / HTML / 文本 / 图片 / hex）→ 断言
 *   - TCP：连接面板 + 双向面板（hexdump 虚拟滚动 / 多解码策略 / 模板与循环发送）
 *   - WS：全部连接经宿主权限与代理桥；hex/text 双视图 + ping/pong 计数
 */
import {
  DEFAULT_ENVS, EnvStore, envResolve, buildUrl,
  parseCurl, toCurl,
  jsonPathQuery, runAssertions, ASSERT_TYPES,
  RingBuffer, formatHexDump, RX_BUFFER_MAX,
  BUILTIN_DECODERS, applyDecoder, testDecoder,
  encodeSend, SEND_KINDS, base64Encode,
  formatBytes, formatMs, classifyStatus, netError,
  HistoryStore, CollectionStore, HISTORY_LIMIT,
  wsUrlKind, flattenJson, htmlPreview
} from './core.js'

const api = window.enest || window.zapi
const $ = (sel, root = document) => root.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })

// ———— 会话状态 ————

let sessionSeq = 0
const sessions = new Map() // id → session
let activeId = null

function newSession(kind, patch = {}) {
  const id = `s-${++sessionSeq}`
  const base = {
    id, kind,
    name: kind === 'http' ? 'HTTP' : kind === 'tcp' ? 'TCP' : 'WS',
    // http
    method: 'GET', url: '', headersKv: [], paramsKv: [],
    bodyKind: 'none', bodyText: '',
    asserts: [],
    resp: null,
    // tcp
    host: '127.0.0.1', port: 8080, tls: false, timeoutMs: 10000,
    socketId: null, rx: new RingBuffer(), rxSinceDecode: false,
    decoderId: 'hexdump', regexPattern: '', showTimestamp: false,
    sendHistory: [], loopTimer: null, loopLeft: 0,
    // ws
    wsUrl: '', ws: null, wsFrames: [], wsPing: 0, wsPong: 0,
    wsView: 'text', wsPaused: false, wsBridgeUrl: '',
    // ui
    respView: 'pretty', paused: false
  }
  const s = Object.assign(base, patch)
  sessions.set(id, s)
  return s
}

// ———— 持久化（storage）————

const kit = PluginKit.create({
  title: '网络调试台',
  quickPlaceholder: 'http(s)://… 即发 · host:port 探活 · curl 开头解析发送',
  height: 520
})

const envStore = new EnvStore(DEFAULT_ENVS)
const history = new HistoryStore()
const collections = new CollectionStore(null)
const customDecoders = [] // [{ id, name, code }]

// quick ↔ shell 容器迁移（不重载页面）：切换布局形态并重渲染当前会话
kit.onMode(() => renderBody())

async function persistAll() {
  await Promise.allSettled([
    kit.save('netkit_envs', envStore.toJSON()),
    kit.save('netkit_history', history.toJSON()),
    kit.save('netkit_collections', collections.toJSON()),
    kit.save('netkit_decoders', customDecoders)
  ])
}

async function restoreAll() {
  try {
    const [envs, hist, cols, decs] = await Promise.all([
      kit.load('netkit_envs', null),
      kit.load('netkit_history', []),
      kit.load('netkit_collections', null),
      kit.load('netkit_decoders', [])
    ])
    if (envs) Object.assign(envStore.vars, envs)
    envStore.names = Object.keys(envStore.vars)
    history.items = Array.isArray(hist) ? hist : []
    if (cols?.groups?.length) collections.groups = cols.groups
    if (Array.isArray(decs)) customDecoders.push(...decs.filter((d) => d?.id && typeof d?.code === 'string'))
  } catch { /* 首次运行无数据 */ }
}

// ———— 底栏状态 ————

const footStatus = $('#foot-status')
function setStatus(text) {
  footStatus.textContent = text
}

// ———— Tab 条 ————

const tabsBox = $('#tabs')
function renderTabs() {
  tabsBox.replaceChildren()
  for (const s of sessions.values()) {
    const tab = el('button', 'nk-tab' + (s.id === activeId ? ' active' : ''))
    tab.type = 'button'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(s.id === activeId))
    tab.append(el('span', '', `${s.name}`))
    const x = el('button', 'nk-tab-x', '✕')
    x.title = '关闭会话'
    x.addEventListener('click', (e) => { e.stopPropagation(); closeSession(s.id) })
    tab.append(x)
    tab.addEventListener('click', () => { activeId = s.id; renderTabs(); renderBody() })
    tabsBox.append(tab)
  }
  const add = el('button', 'nk-tab-add', '+ 新会话')
  add.type = 'button'
  add.addEventListener('click', () => {
    const s = newSession('http')
    activeId = s.id
    renderTabs(); renderBody()
  })
  tabsBox.append(add)
}

function closeSession(id) {
  const s = sessions.get(id)
  if (!s) return
  stopLoop(s)
  s.httpDispose?.(); s.httpDispose = null; s.resp = null
  try { s.socketId && api?.net?.socket?.close?.(s.socketId) } catch { /* 已关 */ }
  try { s.ws?.close() } catch { /* 已关 */ }
  sessions.delete(id)
  if (activeId === id) activeId = sessions.keys().next().value ?? null
  if (!activeId) {
    const s2 = newSession('http')
    activeId = s2.id
  }
  renderTabs(); renderBody()
}

// ———— 模式条 ————

const MODES = [['http', 'HTTP'], ['tcp', 'TCP'], ['ws', 'WebSocket']]
$('#modes').replaceChildren(
  ...MODES.map(([kind, label]) => {
    const b = el('button', '', label)
    b.type = 'button'
    b.addEventListener('click', () => {
      const cur = sessions.get(activeId)
      if (cur && cur.kind === kind) return
      if (cur && isSessionEmpty(cur)) {
        // 空会话就地切换 kind
        const fresh = newSession(kind, { id: cur.id })
        sessions.delete(cur.id)
        sessions.set(fresh.id, fresh)
      } else {
        const s = newSession(kind)
        activeId = s.id
      }
      renderTabs(); renderBody()
    })
    b.dataset.kind = kind
    return b
  })
)

function isSessionEmpty(s) {
  if (s.kind === 'http') return !s.url && !s.headersKv.length && !s.resp
  if (s.kind === 'tcp') return !s.socketId && !s.rx.length
  return !s.ws && !s.wsFrames.length
}

// ———— 环境选择 ————

const envSelect = $('#env-select')
function renderEnvSelect() {
  envSelect.replaceChildren(
    ...envStore.names.map((n) => new Option(n, n, n === envStore.current, n === envStore.current))
  )
}
envSelect.addEventListener('change', () => envStore.pick(envSelect.value))
$('#env-edit').addEventListener('click', () => openEnvDialog())

function currentVars() {
  return envStore.varsOf(envStore.current)
}

// ———— 主体渲染 ————

const bodyBox = $('#body')
function renderBody() {
  const s = sessions.get(activeId)
  if (!s) return
  for (const b of $('#modes').children) b.classList.toggle('active', b.dataset.kind === s.kind)
  if (kit.mode === 'shell') {
    bodyBox.classList.remove('nk-single')
    bodyBox.classList.add('nk-split')
    bodyBox.replaceChildren(...buildDesktopCols(s))
  } else {
    bodyBox.classList.remove('nk-split')
    bodyBox.classList.add('nk-single')
    bodyBox.replaceChildren(buildQuickBody(s))
  }
}

/** 桌面三栏：集合树 | 构建列 | 响应/字节流列（TCP / WS 场景响应列并入构建列） */
function buildDesktopCols(s) {
  const tree = buildTreeCol()
  if (s.kind === 'http') {
    const mid = el('div', 'nk-col')
    mid.append(buildHttpBuilder(s))
    return [tree, mid, buildHttpRespCol(s)]
  }
  const main = el('div', 'nk-col')
  main.style.gridColumn = '2 / 4'
  main.append(s.kind === 'tcp' ? buildTcpPanel(s) : buildWsPanel(s))
  return [tree, main]
}

// Quick 形态：单列（构建 + 响应/流）
function buildQuickBody(s) {
  const wrap = el('div', 'nk-col')
  if (s.kind === 'http') {
    wrap.append(buildHttpBuilder(s), buildHttpRespCol(s))
    wrap.style.display = 'grid'
    wrap.style.gridTemplateRows = 'auto minmax(0, 1fr)'
  } else if (s.kind === 'tcp') {
    wrap.append(buildTcpPanel(s))
  } else {
    wrap.append(buildWsPanel(s))
  }
  return wrap
}

// ———— 集合树列 ————

let treeCollapsed = new Set()
function buildTreeCol() {
  const col = el('div', 'nk-col nk-col-tree')
  const card = el('div', 'nk-card')
  const head = el('div', 'nk-card-head')
  head.append(el('span', '', '集合'))
  head.append(Object.assign(el('button', 'nk-btn tiny ghost', '+ 分组'), {
    onclick: () => {
      promptDialog('新建分组', '分组名称', (name) => {
        if (name) { collections.addGroup(name); persistAll(); renderBody() }
      })
    }
  }))
  card.append(head)
  const tree = el('div', 'nk-tree nk-card-body')
  if (!collections.groups.length) {
    tree.append(el('div', 'nk-tree-empty', '暂无集合\n在请求区点击「存入集合」保存常用请求'))
  }
  for (const g of collections.groups) {
    const item = el('div', 'nk-tree-group')
    const headBtn = el('button', 'nk-tree-head')
    headBtn.type = 'button'
    headBtn.append(el('span', 'caret', treeCollapsed.has(g.id) ? '▶' : '▼'))
    headBtn.append(el('span', '', g.name))
    headBtn.append(el('span', 'pk-muted', ` ${g.requests.length}`))
    headBtn.addEventListener('click', () => {
      treeCollapsed.has(g.id) ? treeCollapsed.delete(g.id) : treeCollapsed.add(g.id)
      renderBody()
    })
    headBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      confirmDialog('删除分组', `删除分组「${g.name}」及其 ${g.requests.length} 个请求？`, () => {
        collections.removeGroup(g.id); persistAll(); renderBody()
      })
    })
    item.append(headBtn)
    if (!treeCollapsed.has(g.id)) {
      for (const r of g.requests) {
        const rb = el('button', 'nk-tree-item')
        rb.type = 'button'
        rb.title = `${r.method} ${r.url}`
        rb.append(el('span', 'm nk-mono', r.method))
        rb.append(el('span', '', r.url))
        const del = el('button', 'del', '✕')
        del.title = '删除'
        del.addEventListener('click', (e) => { e.stopPropagation(); collections.remove(g.id, r.id); persistAll(); renderBody() })
        rb.append(del)
        rb.addEventListener('click', () => {
          const s = activeSessionOf('http') ?? newSession('http')
          activeId = s.id
          Object.assign(s, { method: r.method, url: r.url, headersKv: structuredClone(r.headersKv ?? []), paramsKv: structuredClone(r.paramsKv ?? []), bodyKind: r.bodyKind ?? 'none', bodyText: r.bodyText ?? '' })
          renderTabs(); renderBody()
        })
        item.append(rb)
      }
    }
    tree.append(item)
  }
  card.append(tree)
  col.append(card)
  return col
}

function activeSessionOf(kind) {
  const cur = sessions.get(activeId)
  if (cur && cur.kind === kind) return cur
  return null
}

// ———— HTTP：构建列 ————

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

function buildHttpBuilder(s) {
  const col = el('div', 'nk-col')
  const card = el('div', 'nk-card')
  const head = el('div', 'nk-card-head')
  head.append(el('span', '', '请求构建'))
  head.append(el('span', 'nk-spacer'))
  head.append(Object.assign(el('button', 'nk-btn tiny ghost', 'curl 导入'), { onclick: () => openCurlDialog(s) }))
  head.append(Object.assign(el('button', 'nk-btn tiny ghost', '导出 curl'), { onclick: () => exportCurl(s) }))
  head.append(Object.assign(el('button', 'nk-btn tiny ghost', '存入集合'), { onclick: () => saveToCollection(s) }))
  card.append(head)

  const body = el('div', 'nk-card-body')
  const row = el('div', 'nk-row')
  const methodSel = el('select', 'nk-select')
  methodSel.setAttribute('aria-label', '请求方法')
  for (const m of METHODS) methodSel.append(new Option(m, m, m === s.method, m === s.method))
  methodSel.addEventListener('change', () => { s.method = methodSel.value })
  const urlInput = el('input', 'nk-input nk-mono grow')
  urlInput.placeholder = 'https://api.example.com/path 或 {{host}}/path'
  urlInput.value = s.url
  urlInput.setAttribute('data-input-context', 'editor')
  urlInput.addEventListener('input', () => { s.url = urlInput.value })
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendHttp(s) } })
  const sendBtn = el('button', 'nk-btn primary', '发送')
  sendBtn.addEventListener('click', () => sendHttp(s))
  row.append(methodSel, urlInput, sendBtn)
  body.append(row)

  // 预览（环境替换 + params 合成）
  const preview = el('div', 'pk-muted nk-mono', '')
  preview.style.cssText = 'font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:4px;'
  const syncPreview = () => {
    const { text, missing } = envResolve(buildUrl(s.url, s.paramsKv), currentVars())
    preview.textContent = '→ ' + text + (missing.length ? `（未定义变量：${missing.join(', ')}）` : '')
    preview.style.color = missing.length ? 'var(--warn)' : 'var(--text-3)'
  }
  urlInput.addEventListener('input', syncPreview)
  syncPreview()

  // Tabs：Params / Headers / Body / 断言
  const sub = el('div', 'nk-seg')
  sub.style.marginTop = '8px'
  const panes = el('div')
  const tabs = [['params', 'Params'], ['headers', 'Headers'], ['body', 'Body'], ['asserts', '断言']]
  let curTab = s.__subTab ?? 'params'
  const renderPane = () => {
    for (const b of sub.children) b.classList.toggle('active', b.dataset.t === curTab)
    panes.replaceChildren()
    if (curTab === 'params') panes.append(buildKvEditor(s.paramsKv, () => syncPreview(), '查询参数'))
    if (curTab === 'headers') panes.append(buildKvEditor(s.headersKv, null, '请求头'))
    if (curTab === 'body') panes.append(buildBodyPane(s))
    if (curTab === 'asserts') panes.append(buildAssertPane(s))
  }
  for (const [t, label] of tabs) {
    const b = el('button', t === curTab ? 'active' : '', label)
    b.type = 'button'
    b.dataset.t = t
    b.addEventListener('click', () => { curTab = t; s.__subTab = t; renderPane() })
    sub.append(b)
  }
  renderPane()
  body.append(sub, panes)
  card.append(body)
  col.append(card)
  s.__syncPreview = syncPreview
  return col
}

/** KV 键值对编辑器（enabled 开关 + 增删） */
function buildKvEditor(kv, onChange, emptyHint) {
  const wrap = el('div')
  const render = () => {
    wrap.replaceChildren()
    if (!kv.length) wrap.append(el('div', 'nk-empty', emptyHint ? `暂无${emptyHint}，点击下方添加` : '空'))
    kv.forEach((pair, idx) => {
      const row = el('div', 'nk-kv')
      const on = el('input')
      on.type = 'checkbox'
      on.checked = pair.enabled !== false
      on.title = on.checked ? '启用' : '禁用'
      on.addEventListener('change', () => { pair.enabled = on.checked; onChange?.() })
      const k = el('input', 'nk-input nk-mono')
      k.placeholder = 'Key'
      k.value = pair.key ?? ''
      k.setAttribute('data-input-context', 'editor')
      k.addEventListener('input', () => { pair.key = k.value; onChange?.() })
      const v = el('input', 'nk-input nk-mono')
      v.placeholder = 'Value（支持 {{var}}）'
      v.value = pair.value ?? ''
      v.setAttribute('data-input-context', 'editor')
      v.addEventListener('input', () => { pair.value = v.value; onChange?.() })
      const del = el('button', 'del', '✕')
      del.title = '删除'
      del.addEventListener('click', () => { kv.splice(idx, 1); render(); onChange?.() })
      row.append(on, k, v, del)
      wrap.append(row)
    })
    const add = el('button', 'nk-btn tiny ghost', '+ 添加')
    add.type = 'button'
    add.style.marginTop = '4px'
    add.addEventListener('click', () => { kv.push({ key: '', value: '', enabled: true }); render() })
    wrap.append(add)
  }
  render()
  return wrap
}

function buildBodyPane(s) {
  const wrap = el('div', 'nk-field')
  const kinds = [['none', '无'], ['json', 'JSON'], ['form', 'Form'], ['raw', 'Raw']]
  const seg = el('div', 'nk-seg')
  for (const [k, label] of kinds) {
    const b = el('button', s.bodyKind === k ? 'active' : '', label)
    b.type = 'button'
    b.addEventListener('click', () => {
      s.bodyKind = k
      for (const x of seg.children) x.classList.toggle('active', x.dataset.k === k)
      renderArea()
    })
    b.dataset.k = k
    seg.append(b)
  }
  wrap.append(seg)
  const err = el('div', 'nk-error')
  err.hidden = true
  const area = el('textarea', 'nk-area')
  area.rows = s.bodyKind === 'none' ? 1 : 6
  area.placeholder = s.bodyKind === 'json' ? '{"key": "value"}（发送前自动校验）' : s.bodyKind === 'form' ? 'key=value&key2=value2' : '原始文本'
  area.value = s.bodyText
  area.setAttribute('data-input-context', 'editor')
  area.addEventListener('input', () => { s.bodyText = area.value })
  const renderArea = () => {
    area.rows = s.bodyKind === 'none' ? 1 : 6
    area.disabled = s.bodyKind === 'none'
    if (s.bodyKind === 'none') { err.hidden = true; return }
    if (s.bodyKind === 'json' && area.value.trim()) {
      try {
        JSON.parse(envResolve(area.value, currentVars()).text)
        err.hidden = true
      } catch (e) {
        err.textContent = 'JSON 校验失败：' + e.message
        err.hidden = false
      }
    } else err.hidden = true
  }
  area.addEventListener('input', renderArea)
  renderArea()
  wrap.append(area, err)
  return wrap
}

function buildAssertPane(s) {
  const wrap = el('div', 'nk-asserts')
  const render = () => {
    wrap.replaceChildren()
    s.asserts.forEach((a, idx) => {
      const row = el('div', 'nk-assert')
      const typeSel = el('select', 'nk-select')
      for (const [t, meta] of Object.entries(ASSERT_TYPES)) typeSel.append(new Option(meta.label, t, t === a.type, t === a.type))
      typeSel.addEventListener('change', () => { a.type = typeSel.value })
      const target = el('input', 'nk-input nk-mono')
      target.placeholder = 'JSONPath（如 $.data.list[0].id）'
      target.value = a.target ?? ''
      target.setAttribute('data-input-context', 'editor')
      target.addEventListener('input', () => { a.target = target.value })
      const expected = el('input', 'nk-input nk-mono')
      expected.placeholder = '期望值'
      expected.value = a.expected ?? ''
      expected.setAttribute('data-input-context', 'editor')
      expected.addEventListener('input', () => { a.expected = expected.value })
      const res = el('span', 'res ' + (a.result ? (a.result.pass ? 'pass' : 'fail') : 'idle'), a.result ? (a.result.pass ? 'pass' : 'fail') : '—')
      res.title = a.result ? `实际：${a.result.actual}` : '发送后自动执行'
      const del = el('button', 'del', '✕')
      del.addEventListener('click', () => { s.asserts.splice(idx, 1); render() })
      row.append(typeSel, target, expected, res, del)
      wrap.append(row)
    })
    const add = el('button', 'nk-btn tiny ghost', '+ 添加断言')
    add.type = 'button'
    add.addEventListener('click', () => {
      s.asserts.push({ type: 'statusEq', target: '', expected: '200' })
      render()
    })
    wrap.append(add)
  }
  render()
  return wrap
}

// ———— HTTP：发送（流式）————

function sendHttp(s) {
  const vars = currentVars()
  const urlRes = envResolve(buildUrl(s.url.trim(), s.paramsKv), vars)
  if (!urlRes.text) return
  if (urlRes.missing.length) {
    kit.toast(`未定义环境变量：${urlRes.missing.join(', ')}`, 'error')
    return
  }
  const headers = {}
  for (const h of s.headersKv) {
    if (h.enabled !== false && h.key) headers[h.key] = envResolve(h.value ?? '', vars).text
  }
  let body
  if (s.method !== 'GET' && s.method !== 'HEAD' && s.bodyKind !== 'none') {
    body = s.bodyText
    if (s.bodyKind === 'json') body = envResolve(body, vars).text
  }
  s.httpDispose?.()
  s.httpDispose = null
  const started = performance.now()
  s.resp = { pending: true, status: 0, headers: {}, chunks: [], sseEvents: [], bytes: 0, reqId: null, early: [] }
  const response = s.resp
  s.asserts.forEach((a) => { a.result = null })
  setStatus('请求中…')
  renderBody()

  // 宿主可能在 net.fetch 元信息返回前就开始推送分片（body pump 先于 handler 返回）：
  // reqId 未定时先入 early 队列，元信息到达后回放，避免丢首帧/丢 done。
  s.httpDispose?.() // 上一次请求的监听器先移除，连续请求不会重复累计分片
  const off = api?.net?.onChunk?.((ev) => {
    if (s.resp !== response) return
    if (s.resp.reqId === null) {
      s.resp.early.push(ev)
      return
    }
    if (ev.reqId !== s.resp.reqId) return
    consumeChunk(s, ev, started)
  })

  s.httpDispose = off
  api.net.fetch({
    url: urlRes.text,
    method: s.method,
    headers,
    body,
    stream: true,
    timeoutMs: 30000
  }).then((res) => {
    if (s.resp !== response) return
    s.resp.reqId = res.reqId
    s.resp.status = res.status
    s.resp.headers = res.headers
    s.resp.sse = (res.headers['content-type'] ?? '').includes('text/event-stream')
    // 回放 reqId 未定期间积压的分片（过滤其它请求的杂音）
    const early = s.resp.early
    s.resp.early = []
    for (const ev of early) {
      if (ev.reqId === res.reqId) consumeChunk(s, ev, started)
    }
    renderBody()
  }).catch((err) => {
    off?.()
    if (s.resp !== response) return
    s.httpDispose = null
    s.resp = { pending: false, error: netError(err?.message), status: 0, headers: {}, chunks: [], sseEvents: [], bytes: 0, early: [] }
    setStatus('请求失败')
    renderBody()
  })
}

function consumeChunk(s, ev, started) {
  if (!s.resp?.pending) return // 终态后忽略迟到分片（防重复 finalize / 重复累计）
  if (ev.error) {
    s.httpDispose?.(); s.httpDispose = null
    s.resp.pending = false
    s.resp.error = netError(ev.error)
    renderBody()
    return
  }
  if (ev.done) {
    finalizeHttp(s, performance.now() - started)
    return
  }
  if (s.resp.sse) {
    s.resp.sseEvents.push({ at: Date.now(), data: ev.chunk })
    s.resp.bytes += new TextEncoder().encode(ev.chunk).length
  } else {
    s.resp.chunks.push(base64ToBytes(ev.chunk))
    s.resp.bytes += (s.resp.chunks[s.resp.chunks.length - 1] || []).length
  }
  if (!s.paused) renderRespIncremental(s)
}

function finalizeHttp(s, elapsedMs) {
  s.httpDispose?.(); s.httpDispose = null
  s.resp.elapsedMs = elapsedMs
  s.resp.pending = false
  const bytes = new Uint8Array(s.resp.bytes ? mergeChunks(s.resp.chunks) : [])
  const text = new TextDecoder().decode(bytes)
  s.resp.bodyText = text
  try { s.resp.json = text ? JSON.parse(text) : undefined } catch { s.resp.json = undefined }
  // 断言
  if (s.asserts.length) {
    const results = runAssertions(s.asserts, { status: s.resp.status, elapsedMs, bodyText: text, json: s.resp.json })
    s.asserts.forEach((a, i) => { a.result = results[i] })
  }
  // 历史
  history.push({ kind: 'http', method: s.method, url: s.url, status: s.resp.status, ms: Math.round(elapsedMs) })
  persistAll()
  setStatus(`${s.method} ${s.resp.status} · ${formatMs(elapsedMs)} · ${formatBytes(s.resp.bytes)}`)
  renderBody()
}

function mergeChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ———— HTTP：响应列 ————

const RESP_PAGE = 512 * 1024
function buildHttpRespCol(s) {
  const col = el('div', 'nk-col')
  const card = el('div', 'nk-card')
  const head = el('div', 'nk-card-head')
  const r = s.resp
  if (!r) {
    head.append(el('span', '', '响应'))
    card.append(head, el('div', 'nk-card-body nk-empty', '发送请求后在此查看响应\n支持流式渲染 · SSE 逐事件 · 断言自动执行'))
    col.append(card)
    return col
  }
  if (r.error) {
    head.append(el('span', '', '响应'))
    card.append(head, el('div', 'nk-error', r.error))
    col.append(card)
    return col
  }
  const badges = el('div', 'nk-badges')
  const cls = classifyStatus(r.status)
  badges.append(el('span', `nk-badge ${cls}`, r.pending ? '…' : `${r.status || '—'}`))
  if (r.sse) badges.append(el('span', 'nk-badge accent', 'SSE'))
  if (r.pending) badges.append(el('span', 'nk-badge neutral', '接收中'))
  else if (r.elapsedMs != null) badges.append(el('span', 'nk-badge neutral', formatMs(r.elapsedMs)))
  badges.append(el('span', 'nk-badge neutral', formatBytes(r.bytes ?? 0)))
  head.append(badges)
  head.append(el('span', 'nk-spacer'))
  if (r.pending && r.sse) {
    head.append(Object.assign(el('button', 'nk-btn tiny ghost', s.paused ? '继续' : '暂停'), {
      onclick: () => { s.paused = !s.paused; renderBody() }
    }))
  }
  if (!r.pending && r.bodyText != null) {
    head.append(Object.assign(el('button', 'nk-btn tiny ghost', '复制'), { onclick: () => kit.copy(r.bodyText) }))
    head.append(Object.assign(el('button', 'nk-btn tiny ghost', '保存'), { onclick: () => kit.saveText('response.txt', r.bodyText) }))
  }
  card.append(head)

  const bodyEl = el('div', 'nk-card-body')
  if (r.pending && !r.sse && !r.chunks.length) {
    const sk = el('div', 'nk-skeleton')
    sk.style.cssText = 'height:14px;margin:6px 0;'
    bodyEl.append(sk, sk.cloneNode(true), sk.cloneNode(true))
  } else if (r.sse) {
    const feed = el('div', 'nk-sse')
    for (const ev of r.sseEvents) {
      const item = el('div', 'nk-sse-item')
      item.append(el('div', 't', fmtTime(ev.at)))
      item.append(el('div', 'd', ev.data))
      feed.append(item)
    }
    if (!r.sseEvents.length && r.pending) feed.append(el('div', 'nk-empty', '等待事件…'))
    bodyEl.append(feed)
    feed.scrollTop = feed.scrollHeight
  } else {
    const seg = el('div', 'nk-seg')
    const ct = (r.headers['content-type'] ?? '')
    const isImg = ct.startsWith('image/')
    const views = isImg
      ? [['img', '图片'], ['hex', 'Hex']]
      : r.json !== undefined
        ? [['pretty', 'JSON'], ['raw', '文本'], ['html', 'HTML'], ['hex', 'Hex']]
        : ct.includes('html')
          ? [['html', 'HTML'], ['raw', '文本'], ['hex', 'Hex']]
          : [['raw', '文本'], ['hex', 'Hex']]
    if (!views.some(([k]) => k === s.respView)) s.respView = views[0][0]
    for (const [k, label] of views) {
      const b = el('button', s.respView === k ? 'active' : '', label)
      b.type = 'button'
      b.addEventListener('click', () => { s.respView = k; renderBody() })
      seg.append(b)
    }
    bodyEl.append(seg)
    const viewer = el('div', 'nk-viewer')
    viewer.style.marginTop = '6px'
    renderRespView(s, viewer)
    bodyEl.append(viewer)
  }
  card.append(bodyEl)
  col.append(card)
  return col
}

let respPage = 1
function renderRespView(s, viewer) {
  viewer.replaceChildren()
  const r = s.resp
  if (s.respView === 'img') {
    const bytes = mergeChunks(r.chunks)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const img = el('img', 'nk-img-preview')
    img.alt = '响应图片'
    img.src = `data:${r.headers['content-type'] ?? 'image/png'};base64,${btoa(bin)}`
    viewer.append(img)
    return
  }
  if (s.respView === 'hex') {
    const total = r.chunks.reduce((n, c) => n + c.length, 0)
    const cap = RESP_PAGE * respPage
    const slice = mergeChunks(r.chunks).subarray(0, Math.min(total, cap))
    const pre = el('pre', 'nk-viewer', formatHexDump(slice))
    pre.style.cssText = 'background:transparent;padding:0;'
    viewer.append(pre)
    if (total > cap) {
      const more = el('button', 'nk-btn tiny', `加载更多（已截取 ${formatBytes(cap)} / ${formatBytes(total)}）`)
      more.addEventListener('click', () => { respPage++; renderBody() })
      viewer.append(more)
    }
    return
  }
  const text = r.bodyText ?? new TextDecoder().decode(mergeChunks(r.chunks))
  if (s.respView === 'pretty' && r.json !== undefined) {
    const tree = buildJsonTree(r.json)
    viewer.style.padding = '0'
    viewer.append(tree)
  } else if (s.respView === 'html') {
    const pv = htmlPreview(text)
    if (pv.hasTable) {
      const tb = el('table', 'pk-table')
      for (const row of pv.rows) {
        const tr = el('tr')
        for (const cell of row) tr.append(el('td', '', cell))
        tb.append(tr)
      }
      viewer.append(tb)
    } else {
      viewer.textContent = pv.title || pv.heads.join(' · ') || text.slice(0, 2000)
    }
  } else {
    viewer.textContent = text.length > 512 * 1024 ? text.slice(0, 512 * 1024) + '\n…（已截断，可保存查看全部）' : text
  }
}

/** 增量渲染（流式接收中）：只更新字节计数徽章，避免整树重渲染 */
let incrTimer = 0
function renderRespIncremental(s) {
  if (incrTimer) return
  incrTimer = setTimeout(() => {
    incrTimer = 0
    if (!s.resp?.pending) return
    const badge = $('.nk-badges .nk-badge.neutral:last-of-type', bodyBox)
    if (badge) badge.textContent = formatBytes(s.resp.bytes)
  }, 200)
}

/** 可折叠 JSON 树 */
function buildJsonTree(value) {
  const rows = flattenJson(value, { maxDepth: 8, maxNodes: 4000 })
  const root = el('div', 'nk-json')
  const collapsed = new Set()
  const render = () => {
    root.replaceChildren()
    let hideDepth = null
    for (const row of rows) {
      if (hideDepth !== null && row.depth > hideDepth) continue
      hideDepth = null
      const line = el('div', 'nk-json-row')
      line.style.setProperty('--depth', String(row.depth))
      if (row.expandable) {
        const caret = el('button', 'nk-json-caret', collapsed.has(row.path) ? '▶' : '▼')
        caret.addEventListener('click', () => {
          collapsed.has(row.path) ? collapsed.delete(row.path) : collapsed.add(row.path)
          render()
        })
        line.append(caret)
        line.append(el('span', 'nk-json-key', `${row.key}: `))
        line.append(el('span', 'nk-json-preview', row.preview))
        if (collapsed.has(row.path)) hideDepth = row.depth
      } else {
        line.append(el('span', 'nk-json-caret', ' '))
        if (row.key !== '$') line.append(el('span', 'nk-json-key', `${row.key}: `))
        const t = row.type === 'number' ? 't-num' : row.type === 'boolean' ? 't-bool' : row.type === 'null' ? 't-null' : 't-str'
        line.append(el('span', `nk-json-val ${t}`, row.preview))
      }
      root.append(line)
    }
  }
  render()
  return root
}

// ———— HTTP：curl ————

function openCurlDialog(s) {
  promptDialog('导入 curl', '粘贴 curl 命令（支持 -X -H -d --data-raw -F -u -m 等）', (text) => {
    try {
      const req = parseCurl(text)
      s.method = req.method
      s.url = req.url
      s.headersKv = req.headers.map(([k, v]) => ({ key: k, value: v, enabled: true }))
      s.paramsKv = []
      s.bodyKind = req.bodyKind
      s.bodyText = req.body
      renderBody()
      kit.toast('curl 已解析', 'success')
    } catch (err) {
      kit.toast(err.message, 'error')
    }
  }, true)
}

function exportCurl(s) {
  const vars = currentVars()
  const headers = s.headersKv.filter((h) => h.enabled !== false && h.key).map(([k, v] = []) => [k, envResolve(v ?? '', vars).text])
  const curl = toCurl({ method: s.method, url: envResolve(buildUrl(s.url, s.paramsKv), vars).text, headers, body: s.bodyKind !== 'none' ? s.bodyText : '' })
  kit.copy(curl)
}

function saveToCollection(s) {
  if (!s.url) { kit.toast('请先填写 URL', 'warn'); return }
  promptDialog('存入集合', '请求名称', (name) => {
    collections.add(collections.groups[0].id, {
      name: name || s.url, method: s.method, url: s.url,
      headersKv: structuredClone(s.headersKv), paramsKv: structuredClone(s.paramsKv),
      bodyKind: s.bodyKind, bodyText: s.bodyText
    })
    persistAll()
    renderBody()
    kit.toast('已存入集合', 'success')
  })
}

// ———— TCP 面板 ————

function buildTcpPanel(s) {
  const col = el('div', 'nk-col')
  const card = el('div', 'nk-card')
  // 连接面板
  const head = el('div', 'nk-card-head')
  const host = el('input', 'nk-input nk-mono')
  host.placeholder = 'host'
  host.value = s.host
  host.style.width = '160px'
  host.setAttribute('data-input-context', 'editor')
  host.addEventListener('input', () => { s.host = host.value })
  const port = el('input', 'nk-input nk-mono')
  port.type = 'number'
  port.placeholder = 'port'
  port.value = s.port
  port.style.width = '84px'
  port.setAttribute('data-input-context', 'editor')
  port.addEventListener('input', () => { s.port = Number(port.value) || 0 })
  const tls = el('label', 'nk-check')
  const tlsCk = el('input')
  tlsCk.type = 'checkbox'
  tlsCk.checked = s.tls
  tlsCk.addEventListener('change', () => { s.tls = tlsCk.checked })
  tls.append(tlsCk, document.createTextNode('TLS'))
  const timeout = el('input', 'nk-input nk-mono')
  timeout.type = 'number'
  timeout.value = s.timeoutMs
  timeout.title = '连接超时（ms）'
  timeout.style.width = '84px'
  timeout.setAttribute('data-input-context', 'editor')
  timeout.addEventListener('input', () => { s.timeoutMs = Number(timeout.value) || 10000 })
  const connBtn = el('button', 'nk-btn primary', s.socketId ? '已连接' : '连接')
  connBtn.disabled = !!s.socketId
  connBtn.addEventListener('click', () => connectTcp(s))
  const closeBtn = el('button', 'nk-btn danger', '断开')
  closeBtn.disabled = !s.socketId
  closeBtn.addEventListener('click', () => {
    try { api.net.socket.close(s.socketId) } catch { /* 已关 */ }
  })
  head.append(el('span', '', 'TCP'), host, port, tls, timeout, connBtn, closeBtn)
  if (s.dropped) head.append(el('span', 'nk-badge warn', `环形丢弃 ${formatBytes(s.rx.dropped)}`))

  const bodyEl = el('div', 'nk-card-body')
  bodyEl.style.cssText = 'padding:0;overflow:hidden;display:flex;'
  if (!s.socketId && !s.rx.length) {
    bodyEl.style.padding = '0'
    bodyEl.append(Object.assign(el('div', 'nk-empty'), {
      innerHTML: '尚未连接<br>连接后接收区默认以 Hex Dump 渲染<br>支持长度前缀 / 分隔符帧 / 正则 / 自定义 JS 解码器'
    }))
  } else {
    bodyEl.append(buildDuplex(s))
  }
  card.append(head, bodyEl)
  col.append(card)
  s.__connBtn = connBtn
  s.__closeBtn = closeBtn
  return col
}

async function connectTcp(s) {
  if (!s.host || !s.port) { kit.toast('请填写 host 与 port', 'warn'); return }
  setStatus('连接中…')
  try {
    const { socketId } = await api.net.socket.connect({ host: s.host, port: s.port, tls: s.tls, timeoutMs: s.timeoutMs })
    s.socketId = socketId
    s.rx.clear()
    setStatus(`已连接 ${s.host}:${s.port}`)
    kit.toast('连接成功', 'success')
    const offData = api.net.onNetData((ev) => {
      if (ev.socketId !== socketId || !s.socketId) return
      s.rx.push(base64ToBytes(ev.chunk))
      s.dirty = true
      scheduleTcpRender(s)
    })
    const offClose = api.net.onNetClose((ev) => {
      if (ev.socketId !== socketId) return
      offData(); offClose()
      const wasCurrent = s.socketId === socketId
      s.socketId = null
      setStatus(`连接关闭：${netError(ev.reason)}`)
      kit.toast(`连接已关闭（${ev.reason}）`, 'info')
      if (wasCurrent) renderBody()
    })
    renderBody()
  } catch (err) {
    setStatus('连接失败')
    kit.toast(netError(err?.message), 'error')
  }
}

/** TCP 渲染节流：40ms 合并（宿主 20ms 节流之上再合并一次，降低 DOM 压力） */
let tcpTimer = 0
function scheduleTcpRender(s) {
  if (tcpTimer || s.id !== activeId) return
  tcpTimer = setTimeout(() => {
    tcpTimer = 0
    renderDuplexStream(s)
  }, 40)
}

function buildDuplex(s) {
  const wrap = el('div', 'nk-duplex')
  // 接收区
  const top = el('div', 'nk-duplex-top')
  const topHead = el('div', 'nk-card-head')
  const seg = el('div', 'nk-seg')
  const viewIds = [...BUILTIN_DECODERS.map((d) => [d.id, d.label.split('（')[0].split(' · ')[0]]), ...customDecoders.map((c) => [c.id, c.name])]
  if (!viewIds.some(([id]) => id === s.decoderId)) s.decoderId = 'hexdump'
  for (const [id, label] of viewIds) {
    const b = el('button', s.decoderId === id ? 'active' : '', label)
    b.type = 'button'
    b.title = BUILTIN_DECODERS.find((d) => d.id === id)?.label ?? `自定义：${label}`
    b.addEventListener('click', () => { s.decoderId = id; renderDuplexStream(s, true) })
    b.dataset.v = id
    seg.append(b)
  }
  topHead.append(seg)
  topHead.append(el('span', 'nk-spacer'))
  if (s.decoderId === 'regex') {
    const reInput = el('input', 'nk-input nk-mono')
    reInput.placeholder = '正则（如 GET \\S+）'
    reInput.value = s.regexPattern
    reInput.style.width = '140px'
    reInput.setAttribute('data-input-context', 'editor')
    reInput.addEventListener('input', () => { s.regexPattern = reInput.value; renderDuplexStream(s, true) })
    topHead.append(reInput)
  }
  const tsCk = el('label', 'nk-check')
  const ts = el('input')
  ts.type = 'checkbox'
  ts.checked = s.showTimestamp
  ts.addEventListener('change', () => { s.showTimestamp = ts.checked; renderDuplexStream(s, true) })
  tsCk.append(ts, document.createTextNode('时间戳'))
  const clearBtn = el('button', 'nk-btn tiny ghost', '清空')
  clearBtn.addEventListener('click', () => { s.rx.clear(); renderDuplexStream(s, true) })
  topHead.append(tsCk, clearBtn)
  const stream = el('div', 'nk-stream')
  const viewer = el('div', 'nk-viewer')
  viewer.style.background = 'transparent'
  stream.append(viewer)
  top.append(topHead, stream)
  s.__viewer = viewer
  s.__stream = stream

  // 发送区
  const bottom = el('div', 'nk-duplex-bottom')
  const sendRow = el('div', 'nk-row')
  const kindSel = el('select', 'nk-select')
  for (const k of SEND_KINDS) kindSel.append(new Option(k.label, k.id, k.id === s.sendKind, k.id === s.sendKind))
  if (!s.sendKind) s.sendKind = 'text'
  kindSel.addEventListener('change', () => { s.sendKind = kindSel.value })
  const sendInput = el('input', 'nk-input nk-mono grow')
  sendInput.placeholder = '发送内容（hex 用空格分隔；\\n \\t \\x41 转义可用）'
  sendInput.setAttribute('data-input-context', 'editor')
  sendInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); doSend(s, sendInput.value); sendInput.select() } })
  const sendBtn = el('button', 'nk-btn primary', '发送')
  sendBtn.addEventListener('click', () => doSend(s, sendInput.value))
  sendRow.append(kindSel, sendInput, sendBtn)

  const loopRow = el('div', 'nk-loop pk-muted')
  const iv = el('input', 'nk-input nk-mono')
  iv.type = 'number'
  iv.value = s.loopIv ?? 1000
  iv.min = 50
  iv.title = '间隔（ms）'
  const cnt = el('input', 'nk-input nk-mono')
  cnt.type = 'number'
  cnt.value = s.loopCnt ?? 10
  cnt.min = 0
  cnt.title = '次数（0 = 无限）'
  const loopBtn = el('button', 'nk-btn', '循环发送')
  loopBtn.addEventListener('click', () => toggleLoop(s, iv, cnt, loopBtn))
  const histSel = el('select', 'nk-select')
  histSel.append(new Option('发送历史', ''))
  for (const h of s.sendHistory.slice(0, 20)) histSel.append(new Option(`${h.kind}: ${h.text.slice(0, 24)}`, h.text))
  histSel.addEventListener('change', () => { if (histSel.value) { sendInput.value = histSel.value; kindSel.value = s.sendHistory.find((h) => h.text === histSel.value)?.kind ?? kindSel.value } })
  loopRow.append(el('span', '', '循环：'), iv, el('span', '', 'ms ×'), cnt, loopBtn, histSel)

  bottom.append(sendRow, loopRow)
  wrap.append(top, bottom)
  renderDuplexStream(s, true)
  return wrap
}

function renderDuplexStream(s, force) {
  if (!s.__viewer || s.id !== activeId) return
  const bytes = s.rx.snapshot()
  if (!force && !s.dirty) return
  s.dirty = false
  const viewer = s.__viewer
  try {
    let out
    if (s.decoderId === 'hexdump') {
      out = formatHexDump(bytes)
    } else {
      out = applyDecoder(s.decoderId, bytes, customDecoders, { regexPattern: s.regexPattern })
    }
    viewer.replaceChildren()
    if (s.decoderId === 'hexdump' && s.showTimestamp) {
      viewer.classList.add('nk-timed')
      const line = el('span', 'nk-hexline')
      line.append(el('span', 'hx-time', fmtTime(Date.now()) + ' '))
      line.append(el('span', 'hx-byte', out))
      viewer.append(line)
    } else {
      viewer.textContent = out
    }
    if (s.rx.dropped) {
      viewer.prepend(el('div', 'nk-error', `缓冲超 4MB，已丢弃最旧 ${formatBytes(s.rx.dropped)} 数据`))
    }
    s.__stream.scrollTop = s.__stream.scrollHeight
  } catch (err) {
    viewer.replaceChildren(el('div', 'nk-error', `解码失败（策略 ${s.decoderId}）：${err.message}`))
  }
}

async function doSend(s, input) {
  if (!input) return
  if (!s.socketId) { kit.toast('未连接', 'warn'); return }
  try {
    const vars = currentVars()
    const resolved = envResolve(input, vars).text
    const bytes = encodeSend(resolved, s.sendKind)
    // 走 base64 通道保证二进制原样；宿主识别 base64 后按字节发送
    const { sent } = await api.net.socket.send(s.socketId, base64Encode(bytes))
    s.sendHistory.unshift({ kind: s.sendKind, text: input })
    if (s.sendHistory.length > 50) s.sendHistory.length = 50
    setStatus(`已发送 ${sent} B`)
  } catch (err) {
    kit.toast(netError(err?.message), 'error')
  }
}

function toggleLoop(s, ivInput, cntInput, btn) {
  if (s.loopTimer) { stopLoop(s); btn.textContent = '循环发送'; return }
  const input = $('.nk-row .nk-input.grow', s.__viewer?.closest('.nk-duplex') ?? document)
  const text = input?.value
  if (!text) { kit.toast('请先填写发送内容', 'warn'); return }
  const iv = Math.max(50, Number(ivInput.value) || 1000)
  const total = Math.max(0, Number(cntInput.value) || 0)
  s.loopLeft = total
  btn.textContent = '停止'
  const tick = async () => {
    if (!s.socketId || !s.loopTimer) { stopLoop(s); return }
    await doSend(s, text)
    if (total > 0) {
      s.loopLeft--
      if (s.loopLeft <= 0) { stopLoop(s); btn.textContent = '循环发送'; return }
    }
    s.loopTimer = setTimeout(tick, iv)
  }
  s.loopTimer = setTimeout(tick, iv)
}

function stopLoop(s) {
  if (s.loopTimer) { clearTimeout(s.loopTimer); s.loopTimer = null }
}

// ———— WebSocket 面板 ————

function buildWsPanel(s) {
  const col = el('div', 'nk-col')
  const card = el('div', 'nk-card')
  const head = el('div', 'nk-card-head')
  const url = el('input', 'nk-input nk-mono grow')
  url.placeholder = 'wss://host/path（ws:// 明文走宿主桥）'
  url.value = s.wsUrl
  url.setAttribute('data-input-context', 'editor')
  url.addEventListener('input', () => { s.wsUrl = url.value })
  const connBtn = el('button', 'nk-btn primary', s.ws ? '已连接' : '连接')
  connBtn.addEventListener('click', () => connectWs(s))
  const closeBtn = el('button', 'nk-btn danger', '断开')
  closeBtn.disabled = !s.ws
  closeBtn.addEventListener('click', () => { try { s.ws?.close() } catch { /* 已关 */ } })
  head.append(el('span', '', 'WS'), url, connBtn, closeBtn)
  head.append(el('span', 'nk-badge neutral', `ping ${s.wsPing} / pong ${s.wsPong}`))
  card.append(head)
  const bodyEl = el('div', 'nk-card-body')
  bodyEl.style.cssText = 'padding:0;display:flex;flex-direction:column;gap:0;min-height:0;'
  if (!s.ws && !s.wsFrames.length) {
    bodyEl.append(el('div', 'nk-empty', '尚未连接\nWebSocket 连接通过宿主权限与代理；明文连接需显式授权'))
  } else {
    bodyEl.append(buildWsFrames(s))
  }
  card.append(head, bodyEl)
  col.append(card)
  return col
}

async function connectWs(s) {
  const kind = wsUrlKind(s.wsUrl)
  if (kind === 'invalid') { kit.toast('URL 需以 ws:// 或 wss:// 开头', 'warn'); return }
  let target = s.wsUrl.trim()
  try {
    s.wsPing = 0; s.wsPong = 0; s.wsFrames = []
    const { socketId } = await api.net.websocket.connect({ url: target })
    const disposers = []
    const ws = {
      readyState: 1,
      send(data) {
        let payload = data, binary = false
        if (typeof data !== 'string') {
          const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)
          let encoded = ''
          for (const byte of bytes) encoded += String.fromCharCode(byte)
          payload = btoa(encoded)
          binary = true
        }
        void api.net.websocket.send(socketId, payload, binary).catch(error => kit.toast(error.message, 'error'))
      },
      close() {
        if (ws.readyState === 3) return
        ws.readyState = 3
        disposers.splice(0).forEach(dispose => dispose())
        ws.onclose?.({ code: 1000 })
        void api.net.websocket.close(socketId).catch(error => kit.toast(error.message, 'error'))
      }
    }
    disposers.push(api.net.websocket.onMessage(event => {
      if (event.socketId !== socketId) return
      const data = event.binary ? Uint8Array.from(atob(event.data), character => character.charCodeAt(0)).buffer : event.data
      ws.onmessage?.({ data })
    }))
    disposers.push(api.net.websocket.onClose(event => {
      if (event.socketId !== socketId) return
      ws.readyState = 3; disposers.splice(0).forEach(dispose => dispose()); ws.onclose?.(event)
    }))
    s.ws = ws
    setStatus(`WS 已连接 ${target}`)
    ws.onclose = (ev) => {
      if (s.ws === ws) s.ws = null
      s.wsFrames.push({ dir: 'sys', at: Date.now(), text: `closed (${ev.code})` })
      setStatus('WS 已关闭')
      renderBody()
    }
    ws.onerror = () => {
      kit.toast('WS 错误：握手失败或证书无效', 'error')
    }
    ws.onmessage = (ev) => {
      if (s.wsPaused) return
      const isBin = ev.data instanceof ArrayBuffer
      const text = isBin ? `binary ${ev.data.byteLength}B\n` + formatHexDump(new Uint8Array(ev.data).subarray(0, 512)) : String(ev.data)
      s.wsFrames.push({ dir: 'in', at: Date.now(), text, bin: isBin ? new Uint8Array(ev.data) : null })
      if (s.wsFrames.length > 500) s.wsFrames.shift()
      renderWsFrames(s)
    }
    // ping/pong 计数：浏览器层不暴露控制帧，用应用层探测（发送 'ping' 文本计数仅供参考）
    renderBody()
  } catch (err) {
    kit.toast(netError(err?.message), 'error')
  }
}

function buildWsFrames(s) {
  const wrap = el('div')
  wrap.style.cssText = 'display:flex;flex-direction:column;min-height:0;flex:1;'
  const bar = el('div', 'nk-card-head')
  const seg = el('div', 'nk-seg')
  for (const [k, label] of [['text', 'Text'], ['hex', 'Hex']]) {
    const b = el('button', s.wsView === k ? 'active' : '', label)
    b.type = 'button'
    b.addEventListener('click', () => { s.wsView = k; renderWsFrames(s) })
    seg.append(b)
  }
  const pauseBtn = el('button', 'nk-btn tiny ghost', s.wsPaused ? '继续' : '暂停')
  pauseBtn.addEventListener('click', () => { s.wsPaused = !s.wsPaused; pauseBtn.textContent = s.wsPaused ? '继续' : '暂停' })
  const clearBtn = el('button', 'nk-btn tiny ghost', '清空')
  clearBtn.addEventListener('click', () => { s.wsFrames = []; renderWsFrames(s) })
  bar.append(seg, el('span', 'nk-spacer'), pauseBtn, clearBtn)
  const feed = el('div', 'nk-sse')
  feed.style.flex = '1'
  feed.style.minHeight = '140px'
  wrap.append(bar, feed)
  s.__wsFeed = feed
  renderWsFeed(s)
  const sendRow = el('div', 'nk-row')
  sendRow.style.padding = '6px 8px'
  sendRow.style.borderTop = '1px solid var(--border)'
  const input = el('input', 'nk-input nk-mono grow')
  input.placeholder = '发送文本（hex 视图下按 hex 字面发送）'
  input.setAttribute('data-input-context', 'editor')
  const btn = el('button', 'nk-btn primary', '发送')
  btn.addEventListener('click', () => {
    if (!s.ws || s.ws.readyState !== 1) { kit.toast('未连接', 'warn'); return }
    const text = input.value
    if (!text) return
    if (s.wsView === 'hex') {
      try {
        const bytes = encodeSend(text, 'hex')
        s.ws.send(bytes)
        s.wsFrames.push({ dir: 'out', at: Date.now(), text: `[hex] ${text}` })
      } catch (err) { kit.toast(err.message, 'error'); return }
    } else {
      s.ws.send(text)
      s.wsFrames.push({ dir: 'out', at: Date.now(), text })
    }
    input.value = ''
    renderWsFrames(s)
  })
  sendRow.append(input, btn)
  wrap.append(sendRow)
  return wrap
}

function renderWsFrames(s) {
  const feed = s.__wsFeed
  if (!feed || s.id !== activeId) return
  renderWsFeed(s)
}

function renderWsFeed(s) {
  const feed = s.__wsFeed
  if (!feed) return
  feed.replaceChildren()
  for (const f of s.wsFrames.slice(-200)) {
    const item = el('div', 'nk-sse-item')
    const dirLabel = f.dir === 'in' ? '↓ 收' : f.dir === 'out' ? '↑ 发' : '· '
    const cls = f.dir === 'in' ? 'ok' : f.dir === 'out' ? 'accent' : 'neutral'
    item.append(el('div', 't', `${fmtTime(f.at)} ${dirLabel}`))
    const d = el('div', 'd', f.text)
    if (f.dir === 'out') d.style.color = 'var(--accent)'
    item.append(d)
    item.classList.add(cls)
    feed.append(item)
  }
  feed.scrollTop = feed.scrollHeight
}

// ———— 历史面板 ————

$('#btn-history').addEventListener('click', () => {
  const dlg = $('#dlg')
  dlg.replaceChildren()
  const head = el('div', 'nk-dlg-head')
  head.append(el('span', '', `历史（最近 ${Math.min(history.items.length, HISTORY_LIMIT)} 条）`))
  const clear = el('button', 'x nk-btn tiny ghost', '清空')
  clear.addEventListener('click', () => { history.clear(); persistAll(); renderBody(); dlg.close() })
  const x = el('button', 'x', '✕')
  x.addEventListener('click', () => dlg.close())
  head.append(clear, x)
  const list = el('ul', 'nk-hist nk-dlg-body')
  if (!history.items.length) list.append(el('div', 'nk-empty', '暂无历史'))
  for (const h of history.items) {
    const li = el('li')
    li.append(el('span', 'm', h.method ?? '—'))
    li.append(el('span', 'u', h.url))
    li.append(el('span', `s ${classifyStatus(h.status ?? 0)}`, h.status ? String(h.status) : 'ERR'))
    li.append(el('span', 'pk-muted nk-mono', h.ms != null ? formatMs(h.ms) : ''))
    li.addEventListener('click', () => {
      const s = activeSessionOf('http') ?? newSession('http')
      activeId = s.id
      s.url = h.url
      dlg.close()
      renderTabs(); renderBody()
    })
    list.append(li)
  }
  dlg.append(head, list)
  dlg.showModal()
})

// ———— 集合管理入口（复用树；对话框仅提示）———

$('#btn-sets').addEventListener('click', () => {
  const dlg = $('#dlg')
  dlg.replaceChildren()
  const head = el('div', 'nk-dlg-head')
  head.append(el('span', '', '集合'))
  const x = el('button', 'x', '✕')
  x.addEventListener('click', () => dlg.close())
  head.append(x)
  const body = el('div', 'nk-dlg-body')
  for (const g of collections.groups) {
    body.append(el('div', '', `${g.name}（${g.requests.length}）`))
    for (const r of g.requests) {
      const row = el('div', 'nk-row')
      row.append(el('span', 'm nk-mono pk-muted', r.method))
      row.append(el('span', 'grow nk-mono', r.url))
      const del = el('button', 'nk-btn tiny danger', '删除')
      del.addEventListener('click', () => { collections.remove(g.id, r.id); persistAll(); dlg.close(); renderBody() })
      row.append(del)
      body.append(row)
    }
  }
  dlg.append(head, body)
  dlg.showModal()
})

// ———— 环境变量编辑对话框 ————

function openEnvDialog() {
  const dlg = $('#dlg')
  dlg.replaceChildren()
  const head = el('div', 'nk-dlg-head')
  head.append(el('span', '', `环境变量 · ${envStore.current}`))
  const x = el('button', 'x', '✕')
  x.addEventListener('click', () => { persistAll(); dlg.close(); renderBody() })
  head.append(x)
  const body = el('div', 'nk-dlg-body')
  body.append(el('div', 'pk-muted', '在 URL / Header / Body 中以 {{key}} 引用；按环境独立保存。'))
  const kv = []
  for (const [k, v] of Object.entries(envStore.varsOf(envStore.current))) kv.push({ key: k, value: v, enabled: true })
  body.append(buildKvEditor(kv, null, '变量'))
  const save = el('button', 'nk-btn primary', '保存')
  save.addEventListener('click', () => {
    const fresh = {}
    for (const p of kv) if (p.key && p.enabled !== false) fresh[p.key] = p.value ?? ''
    envStore.vars[envStore.current] = fresh
    persistAll()
    dlg.close()
    renderBody()
    kit.toast('环境变量已保存', 'success')
  })
  body.append(save)
  dlg.append(head, body)
  dlg.showModal()
}

// ———— 通用对话框 ————

function promptDialog(title, desc, onSubmit, multiline = false) {
  const dlg = $('#dlg')
  dlg.replaceChildren()
  const head = el('div', 'nk-dlg-head')
  head.append(el('span', '', title))
  const x = el('button', 'x', '✕')
  x.addEventListener('click', () => dlg.close())
  head.append(x)
  const body = el('div', 'nk-dlg-body')
  body.append(el('div', 'pk-muted', desc))
  const input = multiline ? el('textarea', 'nk-area') : el('input', 'nk-input nk-mono')
  if (multiline) { input.rows = 5; input.style.fontFamily = 'var(--mono)' }
  input.setAttribute('data-input-context', 'editor')
  const ok = el('button', 'nk-btn primary', '确定')
  ok.addEventListener('click', () => { dlg.close(); onSubmit(input.value.trim()) })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (!multiline || (e.metaKey || e.ctrlKey)) && !e.isComposing) { e.preventDefault(); dlg.close(); onSubmit(input.value.trim()) }
  })
  body.append(input, ok)
  dlg.append(head, body)
  dlg.showModal()
  input.focus()
}

function confirmDialog(title, desc, onOk) {
  const dlg = $('#dlg')
  dlg.replaceChildren()
  const head = el('div', 'nk-dlg-head')
  head.append(el('span', '', title))
  const x = el('button', 'x', '✕')
  x.addEventListener('click', () => dlg.close())
  head.append(x)
  const body = el('div', 'nk-dlg-body')
  body.append(el('div', '', desc))
  const row = el('div', 'nk-row')
  row.style.justifyContent = 'flex-end'
  const cancel = el('button', 'nk-btn', '取消')
  cancel.addEventListener('click', () => dlg.close())
  const ok = el('button', 'nk-btn danger', '删除')
  ok.addEventListener('click', () => { dlg.close(); onOk() })
  row.append(cancel, ok)
  body.append(row)
  dlg.append(head, body)
  dlg.showModal()
}

// ———— Quick 智能识别 ————

function quickRoute(raw) {
  const q = String(raw ?? '').trim()
  if (!q) return
  const s = sessions.get(activeId)
  if (/^curl\s/i.test(q)) {
    if (s.kind !== 'http') switchKind('http')
    try {
      const req = parseCurl(q)
      const cur = sessions.get(activeId)
      Object.assign(cur, { method: req.method, url: req.url, headersKv: req.headers.map(([k, v]) => ({ key: k, value: v, enabled: true })), bodyKind: req.bodyKind, bodyText: req.body, paramsKv: [] })
      renderBody()
      sendHttp(cur)
      return
    } catch (err) { kit.toast(err.message, 'error'); return }
  }
  if (/^https?:\/\//i.test(q)) {
    if (s.kind !== 'http') switchKind('http')
    const cur = sessions.get(activeId)
    cur.method = 'GET'
    cur.url = q
    renderBody()
    sendHttp(cur)
    return
  }
  const m = /^([\w.-]+):(\d{1,5})$/.exec(q)
  if (m) {
    if (s.kind !== 'tcp') switchKind('tcp')
    const cur = sessions.get(activeId)
    cur.host = m[1]
    cur.port = Number(m[2])
    renderBody()
    connectTcp(cur)
    return
  }
  kit.toast('输入 http(s):// 走 HTTP、host:port 探活、curl 开头解析发送', 'info')
}

function switchKind(kind) {
  const cur = sessions.get(activeId)
  const s = newSession(kind)
  if (cur) closeSessionQuiet(cur)
  activeId = s.id
  renderTabs()
  renderBody()
}

function closeSessionQuiet(s) {
  stopLoop(s)
  s.httpDispose?.(); s.httpDispose = null; s.resp = null
  try { s.socketId && api?.net?.socket?.close?.(s.socketId) } catch { /* 已关 */ }
  try { s.ws?.close() } catch { /* 已关 */ }
  sessions.delete(s.id)
}

// ———— 生命周期 ————

api?.onEnter?.((event) => {
  const q = String(event?.payload ?? '').trim()
  if (q) { kit.setQuery(q); quickRoute(q) }
})

api?.onOut?.(() => {
  // 后台暂停循环任务渲染；socket 保持（宿主管理）
})

api?.onBeforeClose?.(async () => {
  for (const s of sessions.values()) {
    stopLoop(s)
    s.httpDispose?.(); s.httpDispose = null; s.resp = null
    try { s.socketId && api?.net?.socket?.close?.(s.socketId) } catch { /* 已关 */ }
    try { s.ws?.close() } catch { /* 已关 */ }
  }
  await persistAll()
})

api?.quickInput?.onAction?.((action) => {
  if (action === 'submit') {
    const value = document.querySelector('.pk-quickbar-input')?.value ?? ''
    quickRoute(value)
  }
})

// ———— 启动 ————

restoreAll().then(() => {
  renderEnvSelect()
  const s = newSession('http')
  activeId = s.id
  renderTabs()
  renderBody()
  setStatus('就绪 · HTTP 流式 / TCP hexdump / WebSocket')
})
