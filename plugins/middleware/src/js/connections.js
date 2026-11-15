/**
 * connections.js — 新建/编辑连接抽屉 + 连接首页（home-grid 卡片视图）
 * - 抽屉：类型宫格按 kinds 注册表渲染；字段组 = 驱动 connectionFields 声明（schema 驱动）
 * - 密码只进 vault：vaultSlot=primary → mw:{connId}；vaultSlot=emqx → mw:{connId}:emqx
 * - 测试连接：临时 config + ephemeralSecret → api.testConnection
 * - 编辑不回显密码（placeholder「留空保持不变」）
 * - renderHome：store.connections 卡片 + overview 健康懒加载 + ⊕ 卡片
 */
import { envChip, chip, escapeHtml, fmt } from './components.js'
import { kindList, kindDot, descriptorOf, connectionFieldsOf } from './kinds.js'
import api from './api.js'
import store from './store.js'
import { renderTree } from './tree.js'
import { renderAll, openConnTab, forgetSessionCaps } from './tabs.js'
import { setLatency } from './status.js'

const ENV_OPTIONS = [
  { value: 'dev', label: '开发 dev' },
  { value: 'test', label: '测试 test' },
  { value: 'staging', label: '预发 staging' },
  { value: 'prod', label: '生产 prod' }
]

let drawerState = null // { root, mask, close }

export function isDrawerOpen() {
  return !!drawerState
}

export function closeDrawer() {
  if (!drawerState) return
  const { root, mask } = drawerState
  drawerState = null
  root.classList.remove('on')
  mask.classList.remove('on')
  if (!document.querySelector('#drawer-root .drawer')) document.body.classList.remove('editable')
  setTimeout(() => {
    root.remove()
    mask.remove()
  }, 240)
}

const esc = escapeHtml

/** pattern 预检（与后端驱动校验同一语义，前端提前拦） */
const PATTERNS = {
  'https-url': v => /^https?:\/\//.test(v) || '需以 http:// 或 https:// 开头',
  'mqtt-url': v => /^(mqtts?|wss?):\/\//.test(v) || '需以 mqtt:// mqtts:// ws:// wss:// 开头',
  'host-ports': v => /^[^,\s]+:\d+(,[^,\s]+:\d+)*$/.test(v.replace(/\s/g, '')) || '格式：host:port，多个用逗号分隔',
  'redis-url': v => /^[^:]+:\d+$/.test(v) || /^rediss?:\/\//.test(v) || /^sentinel:\/\//.test(v) || '格式：host:port 或 redis://…'
}

/** 连接对象里按 path 取值（path=a.b → conn.a.b；缺省平铺顶层） */
function getByPath(obj, field) {
  if (!field.path) return obj[field.key]
  let cur = obj
  for (const seg of field.path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

/** 按 path 写值（组装嵌套对象） */
function setByPath(obj, field, value) {
  if (!field.path) { obj[field.key] = value; return }
  const segs = field.path.split('.')
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    if (!cur[segs[i]] || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {}
    cur = cur[segs[i]]
  }
  cur[segs[segs.length - 1]] = value
}

/** 表单字段可见性：visibleWhen { field, equals, not } */
function fieldVisible(root, field) {
  const cond = field.visibleWhen
  if (!cond) return true
  const control = root.querySelector(`[data-fk="${CSS.escape(cond.field)}"]`)
  if (!control) return true
  let actual
  if (control.classList.contains('switch')) actual = control.classList.contains('on')
  else actual = control.value
  if (cond.equals !== undefined) return cond.not ? actual !== cond.equals : actual === cond.equals
  return cond.not ? !!actual : !actual // 缺省 equals 视为真值
}

/* ———————————————— 抽屉 ———————————————— */

export function openConnectionDrawer(existing = null) {
  if (drawerState) closeDrawer()
  const editing = !!existing
  const c = existing
    ? structuredClone(existing)
    : { id: store.uid('mwc'), kind: 'kafka', name: '', env: 'dev', readOnly: false, note: '' }

  const kinds = kindList()
  const fields = connectionFieldsOf(c.kind)

  const mask = document.createElement('div')
  mask.className = 'mask'
  mask.addEventListener('click', closeDrawer)

  const root = document.createElement('aside')
  root.className = 'drawer'
  root.innerHTML = `
    <div class="dh"><h2>${editing ? '编辑连接' : '新建连接'}</h2><button type="button" class="x" title="关闭">✕</button></div>
    <div class="dbody">
      <div class="type-seg" data-el="typeSeg">
        ${kinds.map((d) => `<button type="button" data-kind="${d.kind}" class="${c.kind === d.kind ? 'on' : ''}" title="${esc(d.label)}${d.defaultPort ? ` · ${d.defaultPort}` : ''}">${kindDot(d.kind)}<span>${esc(d.label)}</span></button>`).join('')}
      </div>
      <div class="form-note"><span>🔐</span><span><b>密码只进保险库</b>：凭据经 enest.vault 存为 secretRef，明文不落盘、不出主进程。</span></div>

      <div class="form-row"><label>连接名称 <span class="req">*</span></label>
        <input type="text" data-fk="name" value="${esc(c.name)}" placeholder="如 prod-kafka" />
      </div>
      <div class="form-row"><label>环境</label>
        <select data-fk="env">${ENV_OPTIONS.map((o) => `<option value="${o.value}" ${c.env === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}</select>
      </div>

      <div data-el="kindFields">
        ${renderFieldsHtml(fields, c, editing)}
      </div>

      <div class="form-row" style="margin-top:16px"><label>备注</label>
        <textarea data-fk="note" rows="2" placeholder="可选">${esc(c.note ?? '')}</textarea>
      </div>
      <div class="switch-row"><button type="button" class="switch ${c.readOnly ? 'on' : ''}" data-fk="readOnly" role="switch" aria-checked="${!!c.readOnly}"></button>
        <span class="sl"><b>只读连接</b>：宿主层拦截全部变更操作（删 Topic / 清空 / 重置 offset / 发消息）</span>
      </div>
      <div class="tip" data-el="testTip" style="min-height:18px;margin-top:10px"></div>
    </div>
    <div class="dfoot"><div class="right">
      <button type="button" class="btn" data-act="test">测试连接</button>
      <button type="button" class="btn" data-act="cancel">取消</button>
      <button type="button" class="btn primary" data-act="save">保存并连接</button>
    </div></div>
  `

  const drawerRoot = document.getElementById('drawer-root')
  drawerRoot.append(mask, root)
  document.body.classList.add('editable') // 表单区 user-select:text（main.css 约定）
  requestAnimationFrame(() => {
    root.classList.add('on')
    mask.classList.add('on')
  })

  drawerState = { root, mask, close: closeDrawer }
  const setTip = (text, type = '') => {
    const el = root.querySelector('[data-el=testTip]')
    el.textContent = text || ''
    el.style.color = type === 'ok' ? 'var(--ok)' : type === 'err' ? 'var(--danger)' : ''
  }

  root.querySelector('.dh .x').addEventListener('click', closeDrawer)
  root.querySelector('[data-act=cancel]').addEventListener('click', closeDrawer)

  // 类型宫格：切换后整组重渲染（各类型已填值暂不跨类型保留，与旧版一致）
  root.querySelector('[data-el=typeSeg]').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-kind]')
    if (!btn) return
    c.kind = btn.dataset.kind
    root.querySelectorAll('[data-el=typeSeg] button').forEach((b) => b.classList.toggle('on', b === btn))
    const host = root.querySelector('[data-el=kindFields]')
    host.innerHTML = renderFieldsHtml(connectionFieldsOf(c.kind), c, editing)
    bindFieldEvents()
  })

  function bindFieldEvents() {
    // switch 通用切换 + 条件显隐联动
    root.querySelectorAll('[data-el=kindFields] .switch').forEach((sw) => {
      sw.addEventListener('click', () => {
        sw.classList.toggle('on')
        sw.setAttribute('aria-checked', sw.classList.contains('on'))
        applyVisibility()
      })
    })
    // select 变化可能影响条件显隐（如 saslMechanism）
    root.querySelectorAll('[data-el=kindFields] select[data-fk]').forEach((sel) => {
      sel.addEventListener('change', applyVisibility)
    })
    applyVisibility()
  }

  function applyVisibility() {
    for (const field of connectionFieldsOf(c.kind)) {
      const el = root.querySelector(`[data-el=kindFields] [data-fk="${CSS.escape(field.key)}"]`)
      if (!el) continue
      const row = el.closest('.form-row, .switch-row')?.parentElement ?? el.closest('.form-row, .switch-row')
      const target = el.closest('.form-row, .switch-row') || el
      void row
      target.style.display = fieldVisible(root, field) ? '' : 'none'
    }
  }

  bindFieldEvents()

  /** 从表单读取连接对象（不含明文密码；密码单独处理） */
  function readForm() {
    const kind = c.kind
    const val = (key) => (root.querySelector(`[data-fk="${CSS.escape(key)}"]`)?.value ?? '').trim()
    const conn = {
      id: c.id,
      kind,
      name: val('name'),
      env: root.querySelector('[data-fk=env]')?.value || 'dev',
      readOnly: root.querySelector('[data-fk=readOnly]')?.classList.contains('on') ?? false,
      note: val('note'),
      secretRef: c.secretRef
    }
    for (const field of connectionFieldsOf(kind)) {
      if (!fieldVisible(root, field)) continue
      if (field.type === 'password') continue // 凭据单独走 vault
      const el = root.querySelector(`[data-el=kindFields] [data-fk="${CSS.escape(field.key)}"]`)
      if (!el) continue
      if (field.type === 'switch') {
        setByPath(conn, field, el.classList.contains('on'))
      } else if (field.type === 'number') {
        const raw = el.value.trim()
        if (raw !== '') setByPath(conn, field, Number(raw))
      } else {
        const value = el.value.trim()
        if (value !== '') setByPath(conn, field, value)
      }
    }
    // emqx 子对象整理：enabled=false 时保留结构但关开关（与旧版语义一致）
    if (kind === 'mqtt') {
      conn.emqx = { ...(c.emqx && typeof c.emqx === 'object' ? c.emqx : {}), ...(conn.emqx ?? {}) }
      if (conn.emqx.enabled === undefined) conn.emqx.enabled = false
      conn.emqx.version = conn.emqx.version || 'auto'
      conn.emqx.apiSecretRef = c.emqx?.apiSecretRef
    }
    return conn
  }

  function validate(conn) {
    if (!conn.name) throw new Error('请填写连接名称')
    for (const field of connectionFieldsOf(conn.kind)) {
      if (!fieldVisible(root, field) || field.type === 'password') continue
      const value = getByPath(conn, field)
      if (field.required && (value === undefined || value === null || value === '')) {
        throw new Error(`请填写${field.label}`)
      }
      if (value !== undefined && value !== '' && field.pattern) {
        const check = PATTERNS[field.pattern]
        const result = check(String(value))
        if (result !== true) throw new Error(`${field.label}${result}`)
      }
    }
  }

  /** 密码 → vault；返回待保存的 conn（secretRef 已回填） */
  async function persistSecrets(conn) {
    for (const field of connectionFieldsOf(conn.kind)) {
      if (field.type !== 'password' || !field.vaultSlot) continue
      const el = root.querySelector(`[data-el=kindFields] [data-fk="${CSS.escape(field.key)}"]`)
      const value = el?.value ?? ''
      if (!value) continue
      const vaultKey = field.vaultSlot === 'emqx' ? `mw:${conn.id}:emqx` : `mw:${conn.id}`
      const ref = await api.vault.set(vaultKey, value)
      if (field.vaultSlot === 'emqx') {
        conn.emqx = { ...(conn.emqx ?? {}), apiSecretRef: ref }
      } else {
        conn.secretRef = ref
      }
    }
    return conn
  }

  /** 表单明文密码 → ephemeralSecret（仅测试连接用） */
  function formSecrets() {
    const secrets = {}
    for (const field of connectionFieldsOf(c.kind)) {
      if (field.type !== 'password') continue
      const el = root.querySelector(`[data-el=kindFields] [data-fk="${CSS.escape(field.key)}"]`)
      const value = el?.value ?? ''
      if (value) secrets[field.vaultSlot ?? 'primary'] = value
    }
    return secrets
  }

  root.querySelector('[data-act=test]').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    const old = btn.textContent
    btn.textContent = '测试中…'
    setTip('正在测试连接…')
    try {
      const conn = readForm()
      validate(conn)
      const secrets = formSecrets()
      const overrides = secrets.primary ? { ephemeralSecret: secrets.primary } : {}
      if (secrets.emqx && conn.emqx) overrides.emqx = { ...conn.emqx, ephemeralSecret: secrets.emqx }
      const res = await api.testConnection(api.toMwConfig(conn, overrides))
      setLatency(Number(res?.latencyMs), conn.id)
      const detail = [res?.message, res?.latencyMs ? `${res.latencyMs}ms` : null].filter(Boolean).join(' · ')
      if (res?.ok === true) {
        setTip(`✅ 连接成功${detail ? ' · ' + detail : ''}`, 'ok')
      } else {
        setTip(`❌ 连接失败：${res?.message || '未知原因'}`, 'err')
      }
    } catch (err) {
      setTip(`❌ ${err?.message || err}`, 'err')
    } finally {
      btn.disabled = false
      btn.textContent = old
    }
  })

  root.querySelector('[data-act=save]').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    try {
      const conn = readForm()
      validate(conn)
      await persistSecrets(conn)
      forgetSessionCaps(conn.id)
      store.upsertConnection(conn)
      store.flush().catch(() => {})
      invalidateHomeCache(conn.id) // 配置可能已变，首页卡片需重探
      closeDrawer()
      renderTree()
      await openConnTab(conn.id)
      renderAll()
      void api.toast(`连接「${conn.name}」已保存`, 'success')
    } catch (err) {
      setTip(`❌ ${err?.message || err}`, 'err')
      btn.disabled = false
    }
  })

  setTimeout(() => root.querySelector('[data-fk=name]')?.focus(), 120)
}

/** 按 connectionFields 声明渲染字段组 HTML */
function renderFieldsHtml(fields, c, editing) {
  const chunks = []
  let i = 0
  while (i < fields.length) {
    const field = fields[i]
    const next = fields[i + 1]
    const html = renderFieldHtml(field, c, editing)
    if (field.half && next?.half) {
      const nextHtml = renderFieldHtml(next, c, editing)
      chunks.push(`<div class="form-cols">${html}${nextHtml}</div>`)
      i += 2
    } else {
      chunks.push(html)
      i += 1
    }
  }
  return chunks.join('')
}

function renderFieldHtml(field, c, editing) {
  const current = getByPath(c, field)
  const label = `${esc(field.label)}${field.required ? ' <span class="req">*</span>' : ''}`
  const tip = field.tip ? `<div class="tip">${esc(field.tip)}</div>` : ''
  if (field.type === 'switch') {
    const on = current !== undefined ? !!current : !!field.default
    return `<div class="switch-row"><button type="button" class="switch ${on ? 'on' : ''}" data-fk="${esc(field.key)}" role="switch" aria-checked="${on}"></button>
      <span class="sl">${label}</span></div>`
  }
  if (field.type === 'select') {
    const value = current !== undefined && current !== null ? String(current) : String(field.default ?? '')
    return `<div class="form-row"><label>${label}</label>
      <select data-fk="${esc(field.key)}">${(field.options ?? []).map((o) => `<option value="${esc(o.value)}" ${value === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
      ${tip}</div>`
  }
  if (field.type === 'password') {
    const hasRef = field.vaultSlot === 'emqx' ? !!c.emqx?.apiSecretRef : !!c.secretRef
    return `<div class="form-row"><label>${label}</label>
      <input type="password" data-fk="${esc(field.key)}" placeholder="${editing && hasRef ? '留空保持不变' : '存入 vault'}" autocomplete="new-password" />
      ${tip}</div>`
  }
  if (field.type === 'number') {
    return `<div class="form-row"><label>${label}</label>
      <input type="number" data-fk="${esc(field.key)}" value="${current !== undefined && current !== null ? esc(String(current)) : (field.default !== undefined ? esc(String(field.default)) : '')}" ${field.min !== undefined ? `min="${field.min}"` : ''} />
      ${tip}</div>`
  }
  return `<div class="form-row"><label>${label}</label>
    <input type="text" data-fk="${esc(field.key)}" value="${current !== undefined && current !== null ? esc(String(current)) : ''}" placeholder="${esc(field.placeholder ?? '')}" autocomplete="off" />
    ${tip}</div>`
}

/* ———————————————— 连接首页 ———————————————— */

/** 卡片 3 格指标：metricsSpec 前 3 个 count 类指标 */
function renderCardMetrics(card, conn, overview) {
  const metricsEl = card.querySelector('[data-el=metrics]')
  const metrics = overview?.metrics || {}
  const spec = (descriptorOf(conn.kind)?.metricsSpec ?? []).filter(s => s.unit === 'count').slice(0, 3)
  const fallback = spec.length ? spec : [{ key: '', label: '指标' }, { key: '', label: '指标' }, { key: '', label: '指标' }]
  metricsEl.innerHTML = ''
  for (const d of fallback) {
    const m = document.createElement('div')
    m.className = 'm'
    const raw = metrics[d.key]
    const isLag = /lag|堆积|unack/i.test(`${d.key}${d.label}`)
    const warn = isLag && Number(raw) > 5000
    const text = raw === undefined || raw === null || raw === '' ? '—' : fmt.compact(raw)
    m.innerHTML = `<div class="k">${esc(d.label)}</div><div class="v ${warn ? 'warn' : ''}">${esc(text)}</div>`
    metricsEl.appendChild(m)
  }
}

function authLabel(conn) {
  if (conn.kind === 'kafka') {
    if (conn.saslMechanism && conn.saslMechanism !== 'none') {
      const short = { 'scram-sha-512': 'SCRAM', 'scram-sha-256': 'SCRAM', plain: 'PLAIN', oauthbearer: 'OAUTH' }[conn.saslMechanism] || 'SASL'
      return `SASL/${short}`
    }
    return conn.tls !== false ? 'TLS' : 'PLAINTEXT'
  }
  if (conn.kind === 'rabbitmq') return conn.username ? 'Basic' : '默认'
  if (conn.kind === 'mqtt') return conn.emqx?.enabled ? 'EMQX' : (conn.username ? 'User/Pass' : '匿名')
  if (conn.kind === 'redis') return conn.secretRef || (conn.redisUrl && /@/.test(conn.redisUrl)) ? 'Auth' : '无鉴权'
  if (conn.kind === 'pulsar') return conn.secretRef ? 'JWT' : '匿名'
  return conn.username ? 'Basic' : '无鉴权'
}

const homeOverviewCache = new Map() // connId -> { ts, overview, latency, error }

function cardShell(conn) {
  const card = document.createElement('div')
  card.className = 'conn-card'
  card.dataset.conn = conn.id
  card.innerHTML = `
    <div class="row1">${kindDot(conn.kind)}<span class="cname">${esc(conn.name || conn.id)}</span>${envChip(conn.env)}<span style="margin-left:auto" data-el="health">${chip('检测中…', '')}</span></div>
    <div class="metrics" data-el="metrics"></div>
    <div class="foot"><span data-el="footLeft">—</span><span class="grow"></span><span data-el="footRight">${esc(authLabel(conn))}</span></div>
  `
  card.addEventListener('click', () => void openConnTab(conn.id))
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    import('./tree.js').then(({ showConnectionMenu }) => showConnectionMenu(conn, e.clientX, e.clientY))
  })
  return card
}

/** 首页卡片渲染 + overview 健康懒加载（顺序拉取，卡片就绪即更新）。root = .page 容器 */
export function renderHome(root, ctx) {
  const home = document.createElement('div')
  home.className = 'home'
  home.style.flex = '1'
  home.style.minHeight = '0'
  const labels = kindList().map(d => d.label).join(' · ')
  home.innerHTML = `
    <h1>中间件控制台</h1>
    <div class="sub">${esc(labels)} 统一管理 —— 连接、Topic、消息溯源、消费组与监控</div>
    <div class="home-grid" data-el="grid"></div>
  `
  const grid = home.querySelector('[data-el=grid]')
  root.innerHTML = ''
  root.appendChild(home)

  const cards = new Map()
  for (const conn of store.connections) {
    const card = cardShell(conn)
    cards.set(conn.id, card)
    grid.appendChild(card)
  }
  const plus = document.createElement('div')
  plus.className = 'conn-card new'
  plus.setAttribute('role', 'button')
  plus.innerHTML = '<span class="plus-big">＋</span>新建连接'
  plus.addEventListener('click', () => openConnectionDrawer())
  grid.appendChild(plus)

  // 懒加载 overview（仅 5 分钟内缓存有效；页面被替换后停止更新）
  void (async () => {
    for (const conn of store.connections) {
      if (!home.isConnected) return
      const card = cards.get(conn.id)
      if (!card || !card.isConnected) continue
      await fillCard(card, conn)
    }
  })()
}

async function fillCard(card, conn) {
  const healthEl = card.querySelector('[data-el=health]')
  const footLeft = card.querySelector('[data-el=footLeft]')

  const cached = homeOverviewCache.get(conn.id)
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    applyOverview(card, conn, cached)
    return
  }

  // 先画骨架指标（overview 到达后 applyOverview 重画）
  renderCardMetrics(card, conn, null)
  try {
    // 首页懒连接：先确保会话打开（已开则宿主复用/重开）
    await api.openConnection(conn)
    const started = Date.now()
    const overview = await api.mw('overview', { sessionKey: api.sessionKeyOf(conn.id) })
    const latency = Date.now() - started
    setLatency(latency, conn.id)
    const entry = { ts: Date.now(), overview, latency, error: null }
    homeOverviewCache.set(conn.id, entry)
    if (card.isConnected) applyOverview(card, conn, entry)
  } catch (e) {
    homeOverviewCache.set(conn.id, { ts: Date.now(), overview: null, latency: null, error: e?.message || String(e) })
    if (!card.isConnected) return
    healthEl.innerHTML = chip('不可达', 'bad')
    footLeft.textContent = e?.message ? String(e.message).slice(0, 60) : '连接失败'
  }
}

function applyOverview(card, conn, entry) {
  const healthEl = card.querySelector('[data-el=health]')
  const footLeft = card.querySelector('[data-el=footLeft]')
  if (entry.error) {
    healthEl.innerHTML = chip('不可达', 'bad')
    return
  }
  const overview = entry.overview || {}
  const brokers = Array.isArray(overview.brokers) ? overview.brokers : []
  const dead = brokers.filter((b) => b && b.alive === false).length
  const notes = Array.isArray(overview.notes) ? overview.notes : []
  if (dead > 0) healthEl.innerHTML = chip('<span class="dot"></span>' + `${dead} 节点离线`, 'bad')
  else if (notes.length) healthEl.innerHTML = chip('<span class="dot"></span>' + `${notes.length} 提示`, 'warn')
  else healthEl.innerHTML = chip('<span class="dot"></span>健康', 'ok')

  renderCardMetrics(card, conn, overview)

  const metrics = overview.metrics || {}
  const cluster = overview.clusterName ? ` · ${String(overview.clusterName).slice(0, 14)}` : ''
  if (conn.kind === 'kafka') footLeft.textContent = `${brokers.length} brokers${cluster}`
  else if (conn.kind === 'rabbitmq') footLeft.textContent = metrics.version ? `RabbitMQ ${metrics.version}` : 'RabbitMQ 管理面'
  else if (conn.kind === 'mqtt') footLeft.textContent = conn.emqx?.enabled ? `EMQX${conn.emqx.version === 'v4' ? ' v4' : ''} 管理面已接入` : '通用 MQTT · 管理面未接入'
  else if (conn.kind === 'redis') footLeft.textContent = `Redis ${metrics.version ?? ''}${conn.redisMode === 'pubsub' ? ' · Pub/Sub' : ''}`
  else if (conn.kind === 'pulsar') footLeft.textContent = `Pulsar${metrics.brokers ? ` · ${metrics.brokers} brokers` : ''}`
  else if (conn.kind === 'activemq') footLeft.textContent = `ActiveMQ ${metrics.version ?? ''}`
  else footLeft.textContent = `经 rocketmq-dashboard${conn.readOnly ? ' · 🔒 只读' : ''}`
}

/** 连接配置变化后清首页缓存 */
export function invalidateHomeCache(connId) {
  if (connId === undefined) homeOverviewCache.clear()
  else homeOverviewCache.delete(connId)
}
