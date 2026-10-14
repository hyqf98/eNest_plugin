/**
 * connections.js — 新建/编辑连接抽屉 + 连接首页（home-grid 卡片视图）
 * - 抽屉：类型四宫格切换 data-f 字段组；密码只进 vault（mw:{connId} / mw:{connId}:emqx）
 * - 测试连接：临时 config + ephemeralSecret → api.testConnection，loading 态 + 结果写 .tip
 * - 编辑不回显密码（placeholder「留空保持不变」）；默认端口提示随类型变（KIND_META.port）
 * - renderHome：store.connections 卡片 + overview 健康懒加载 + ⊕ 卡片
 */
import { KIND_META, kindDot, envChip, chip, escapeHtml, fmt } from './components.js'
import api from './api.js'
import store from './store.js'
import { renderTree } from './tree.js'
import { renderAll, openConnTab } from './tabs.js'
import { setLatency } from './status.js'

const KIND_ORDER = ['kafka', 'rabbitmq', 'mqtt', 'rocketmq']
const SASL_OPTIONS = [
  { value: 'none', label: '无' },
  { value: 'scram-sha-512', label: 'SCRAM-SHA-512' },
  { value: 'scram-sha-256', label: 'SCRAM-SHA-256' },
  { value: 'plain', label: 'PLAIN' }
]
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

/** 必填端点的校验与占位提示（默认端口随类型变） */
const ENDPOINT = {
  kafka: {
    key: 'bootstrapServers',
    label: 'Bootstrap Servers',
    placeholder: '10.2.1.11:9092,10.2.1.12:9092',
    tip: () => `逗号分隔多个 broker 地址 · 默认端口 ${KIND_META.kafka.port}`
  },
  rabbitmq: {
    key: 'managementUrl',
    label: '管理端点',
    placeholder: `http://10.2.1.21:${KIND_META.rabbitmq.port}`,
    tip: () => `15672 管理面 API · 默认端口 ${KIND_META.rabbitmq.port}`
  },
  mqtt: {
    key: 'brokerUrl',
    label: 'Broker URL',
    placeholder: 'mqtt://10.2.1.31:1883 或 mqtts:// wss://',
    tip: () => `默认端口 ${KIND_META.mqtt.port}；EMQX 管理面默认 18083（v4 为 8081）`
  },
  rocketmq: {
    key: 'dashboardUrl',
    label: 'rocketmq-dashboard 地址',
    placeholder: `http://10.2.1.41:${KIND_META.rocketmq.port}`,
    tip: () => `经已部署的 dashboard 接口操作 · 默认端口 ${KIND_META.rocketmq.port}`
  }
}

/* ———————————————— 抽屉 ———————————————— */

export function openConnectionDrawer(existing = null) {
  if (drawerState) closeDrawer()
  const editing = !!existing
  const c = existing
    ? structuredClone(existing)
    : { id: store.uid('mwc'), kind: 'kafka', name: '', env: 'dev', readOnly: false, note: '', tls: true, saslMechanism: 'none' }

  const mask = document.createElement('div')
  mask.className = 'mask'
  mask.addEventListener('click', closeDrawer)

  const root = document.createElement('aside')
  root.className = 'drawer'
  root.innerHTML = `
    <div class="dh"><h2>${editing ? '编辑连接' : '新建连接'}</h2><button type="button" class="x" title="关闭">✕</button></div>
    <div class="dbody">
      <div class="type-seg" data-el="typeSeg">
        ${KIND_ORDER.map((k) => `<button type="button" data-kind="${k}" class="${c.kind === k ? 'on' : ''}">${kindDot(k)}<span>${KIND_META[k].label}</span></button>`).join('')}
      </div>
      <div class="form-note"><span>🔐</span><span><b>密码只进保险库</b>：凭据经 enest.vault 存为 secretRef，明文不落盘、不出主进程。</span></div>

      <div class="form-row"><label>连接名称 <span class="req">*</span></label>
        <input type="text" data-k="name" value="${esc(c.name)}" placeholder="如 prod-kafka" />
      </div>
      <div class="form-row"><label>环境</label>
        <select data-k="env">${ENV_OPTIONS.map((o) => `<option value="${o.value}" ${c.env === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}</select>
      </div>

      <!-- Kafka -->
      <div data-f="kafka" ${c.kind !== 'kafka' ? 'style="display:none"' : ''}>
        <div class="form-row"><label>Bootstrap Servers <span class="req">*</span></label>
          <input type="text" data-k="bootstrapServers" value="${esc(c.bootstrapServers ?? '')}" placeholder="${ENDPOINT.kafka.placeholder}" />
          <div class="tip" data-el="endpointTip">${ENDPOINT.kafka.tip()}</div>
        </div>
        <div class="form-cols">
          <div class="form-row"><label>SASL 机制</label>
            <select data-k="saslMechanism">${SASL_OPTIONS.map((o) => `<option value="${o.value}" ${(c.saslMechanism ?? 'none') === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}</select>
          </div>
          <div class="form-row"><label>用户名</label><input type="text" data-k="username" value="${esc(c.username ?? '')}" placeholder="SASL 用户" autocomplete="off" /></div>
        </div>
        <div class="form-row"><label>密码</label>
          <input type="password" data-k="secret" placeholder="${editing && c.secretRef ? '留空保持不变' : '存入 vault，不落盘'}" autocomplete="new-password" />
        </div>
        <div class="switch-row"><button type="button" class="switch ${c.tls !== false ? 'on' : ''}" data-k="tls" role="switch" aria-checked="${c.tls !== false}"></button>
          <span class="sl"><b>TLS 加密</b>（自签证书可关闭）</span>
        </div>
      </div>

      <!-- RabbitMQ -->
      <div data-f="rabbitmq" ${c.kind !== 'rabbitmq' ? 'style="display:none"' : ''}>
        <div class="form-row"><label>管理端点 <span class="req">*</span></label>
          <input type="text" data-k="managementUrl" value="${esc(c.managementUrl ?? '')}" placeholder="${ENDPOINT.rabbitmq.placeholder}" />
          <div class="tip" data-el="endpointTip">${ENDPOINT.rabbitmq.tip()}</div>
        </div>
        <div class="form-cols">
          <div class="form-row"><label>用户名</label><input type="text" data-k="username" value="${esc(c.username ?? '')}" placeholder="management 用户（guest 仅本机）" autocomplete="off" /></div>
          <div class="form-row"><label>密码</label>
            <input type="password" data-k="secret" placeholder="${editing && c.secretRef ? '留空保持不变' : '存入 vault'}" autocomplete="new-password" />
          </div>
        </div>
        <div class="form-cols">
          <div class="form-row"><label>vhost</label><input type="text" data-k="vhost" value="${esc(c.vhost ?? '')}" placeholder="/" /></div>
        </div>
        <div class="form-note" style="margin-top:14px"><span>ℹ️</span><span>队列/交换机/绑定 CRUD、队头 peek、实时监听（amqplib）均经 15672 管理面。</span></div>
      </div>

      <!-- MQTT -->
      <div data-f="mqtt" ${c.kind !== 'mqtt' ? 'style="display:none"' : ''}>
        <div class="form-row"><label>Broker URL <span class="req">*</span></label>
          <input type="text" data-k="brokerUrl" value="${esc(c.brokerUrl ?? '')}" placeholder="${ENDPOINT.mqtt.placeholder}" />
          <div class="tip" data-el="endpointTip">${ENDPOINT.mqtt.tip()}</div>
        </div>
        <div class="form-cols">
          <div class="form-row"><label>用户名</label><input type="text" data-k="username" value="${esc(c.username ?? '')}" autocomplete="off" /></div>
          <div class="form-row"><label>密码</label>
            <input type="password" data-k="secret" placeholder="${editing && c.secretRef ? '留空保持不变' : '存入 vault'}" autocomplete="new-password" />
          </div>
        </div>
        <div class="form-row"><label>ClientId（缺省自动生成）</label><input type="text" data-k="clientId" value="${esc(c.clientId ?? '')}" placeholder="enest-mw-…" /></div>
        <div class="switch-row"><button type="button" class="switch ${c.emqx?.enabled ? 'on' : ''}" data-k="emqx" role="switch" aria-checked="${!!c.emqx?.enabled}"></button>
          <span class="sl"><b>EMQX 管理适配</b>：启用客户端/订阅/retained 管理与完整监控</span>
        </div>
        <div data-el="emqxFields" ${c.emqx?.enabled ? '' : 'style="display:none"'}>
          <div class="form-row" style="margin-top:10px"><label>EMQX 管理端点</label>
            <input type="text" data-k="emqxApiUrl" value="${esc(c.emqx?.apiUrl ?? '')}" placeholder="http://10.2.1.31:18083（v4 填 8081）" />
          </div>
          <div class="form-cols">
            <div class="form-row"><label>API Key</label><input type="text" data-k="emqxApiKey" value="${esc(c.emqx?.apiKey ?? '')}" autocomplete="off" /></div>
            <div class="form-row"><label>API Secret</label>
              <input type="password" data-k="emqxApiSecret" placeholder="${editing && c.emqx?.apiSecretRef ? '留空保持不变' : '存入 vault'}" autocomplete="new-password" />
            </div>
          </div>
        </div>
        <div class="form-note" style="margin-top:14px"><span>ℹ️</span><span>通用 MQTT 无 Topic 实体与历史消息：仅 pub/sub、retained 快照与 $SYS 监控；EMQX 适配补齐管理面。</span></div>
      </div>

      <!-- RocketMQ -->
      <div data-f="rocketmq" ${c.kind !== 'rocketmq' ? 'style="display:none"' : ''}>
        <div class="form-row"><label>rocketmq-dashboard 地址 <span class="req">*</span></label>
          <input type="text" data-k="dashboardUrl" value="${esc(c.dashboardUrl ?? '')}" placeholder="${ENDPOINT.rocketmq.placeholder}" />
          <div class="tip" data-el="endpointTip">${ENDPOINT.rocketmq.tip()}</div>
        </div>
        <div class="form-cols">
          <div class="form-row"><label>用户名</label><input type="text" data-k="username" value="${esc(c.username ?? '')}" placeholder="dashboard 账号（无鉴权可留空）" autocomplete="off" /></div>
          <div class="form-row"><label>密码</label>
            <input type="password" data-k="secret" placeholder="${editing && c.secretRef ? '留空保持不变' : '存入 vault'}" autocomplete="new-password" />
          </div>
        </div>
        <div class="form-note" style="margin-top:14px"><span>⚠️</span><span>RocketMQ 官方无 HTTP 管理 API，本插件经已部署的 dashboard 接口操作，接口随 dashboard 版本可能变化。</span></div>
      </div>

      <div class="form-row" style="margin-top:16px"><label>备注</label>
        <textarea data-k="note" rows="2" placeholder="可选">${esc(c.note ?? '')}</textarea>
      </div>
      <div class="switch-row"><button type="button" class="switch ${c.readOnly ? 'on' : ''}" data-k="readOnly" role="switch" aria-checked="${!!c.readOnly}"></button>
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
  const get = (key) => root.querySelector(`[data-k="${key}"]`)
  const tipEl = () => root.querySelector('[data-el=testTip]')
  const setTip = (text, type = '') => {
    const el = tipEl()
    el.textContent = text || ''
    el.style.color = type === 'ok' ? 'var(--ok)' : type === 'err' ? 'var(--danger)' : ''
  }

  root.querySelector('.dh .x').addEventListener('click', closeDrawer)
  root.querySelector('[data-act=cancel]').addEventListener('click', closeDrawer)

  // 类型四宫格：切换字段组显隐（保留各类型已填值）
  root.querySelector('[data-el=typeSeg]').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-kind]')
    if (!btn) return
    const kind = btn.dataset.kind
    c.kind = kind
    root.querySelectorAll('[data-el=typeSeg] button').forEach((b) => b.classList.toggle('on', b === btn))
    root.querySelectorAll('[data-f]').forEach((g) => {
      g.style.display = g.dataset.f === kind ? '' : 'none'
    })
    const meta = ENDPOINT[kind]
    const tip = root.querySelector('[data-f="' + kind + '"] [data-el=endpointTip]')
    if (tip && meta) tip.textContent = meta.tip()
  })

  // switch 通用切换
  root.querySelectorAll('.switch').forEach((sw) => {
    sw.addEventListener('click', () => {
      sw.classList.toggle('on')
      sw.setAttribute('aria-checked', sw.classList.contains('on'))
      if (sw.dataset.k === 'emqx') {
        const fields = root.querySelector('[data-el=emqxFields]')
        fields.style.display = sw.classList.contains('on') ? '' : 'none'
      }
    })
  })

  /** 从表单读取连接对象（不含明文密码；密码单独处理） */
  function readForm() {
    const kind = c.kind
    const val = (key) => (get(key)?.value ?? '').trim()
    const conn = {
      id: c.id,
      kind,
      name: val('name'),
      env: get('env')?.value || 'dev',
      readOnly: get('readOnly')?.classList.contains('on') ?? false,
      note: val('note'),
      secretRef: c.secretRef
    }
    if (kind === 'kafka') {
      conn.bootstrapServers = val('bootstrapServers')
      conn.saslMechanism = get('saslMechanism')?.value || 'none'
      conn.username = val('username') || undefined
      conn.tls = get('tls')?.classList.contains('on') ?? true
    } else if (kind === 'rabbitmq') {
      conn.managementUrl = val('managementUrl')
      conn.username = val('username') || undefined
      conn.vhost = val('vhost') || undefined
    } else if (kind === 'mqtt') {
      conn.brokerUrl = val('brokerUrl')
      conn.username = val('username') || undefined
      conn.clientId = val('clientId') || undefined
      const emqxOn = get('emqx')?.classList.contains('on')
      if (emqxOn) {
        conn.emqx = {
          ...(c.emqx && typeof c.emqx === 'object' ? c.emqx : {}),
          enabled: true,
          version: c.emqx?.version || 'auto',
          apiUrl: val('emqxApiUrl') || undefined,
          apiKey: val('emqxApiKey') || undefined,
          apiSecretRef: c.emqx?.apiSecretRef
        }
      } else {
        conn.emqx = { ...(c.emqx || {}), enabled: false }
      }
    } else if (kind === 'rocketmq') {
      conn.dashboardUrl = val('dashboardUrl')
      conn.username = val('username') || undefined
    }
    return conn
  }

  function validate(conn) {
    if (!conn.name) throw new Error('请填写连接名称')
    const meta = ENDPOINT[conn.kind]
    if (!conn[meta.key]) throw new Error(`请填写${meta.label}`)
    if (conn.kind === 'kafka' && !/^[^,\s]+:\d+(,[^,\s]+:\d+)*$/.test(conn.bootstrapServers.replace(/\s/g, ''))) {
      throw new Error('Bootstrap Servers 格式：host:port，多个用逗号分隔')
    }
    if (['rabbitmq', 'rocketmq'].includes(conn.kind) && !/^https?:\/\//.test(conn[meta.key])) {
      throw new Error(`${meta.label}需以 http:// 或 https:// 开头`)
    }
    if (conn.kind === 'mqtt' && !/^(mqtts?|wss?):\/\//.test(conn.brokerUrl)) {
      throw new Error('Broker URL 需以 mqtt:// mqtts:// ws:// wss:// 开头')
    }
  }

  /** 密码 → vault；返回待保存的 conn（secretRef 已回填） */
  async function persistSecrets(conn) {
    const pwd = get('secret')?.value ?? ''
    if (pwd) {
      conn.secretRef = await api.vault.set(`mw:${conn.id}`, pwd)
    }
    if (conn.kind === 'mqtt' && conn.emqx?.enabled) {
      const emqxSecret = get('emqxApiSecret')?.value ?? ''
      if (emqxSecret) {
        conn.emqx.apiSecretRef = await api.vault.set(`mw:${conn.id}:emqx`, emqxSecret)
      }
    }
    return conn
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
      const pwd = get('secret')?.value ?? ''
      const overrides = pwd ? { ephemeralSecret: pwd } : {}
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

  setTimeout(() => get('name')?.focus(), 120)
}

/* ———————————————— 连接首页 ———————————————— */

/** 各 kind 卡片指标候选键（宿主 metrics 键名未知，逐个探测） */
const METRIC_KEYS = {
  kafka: { a: ['topics', 'topicCount', 'topicTotal'], b: ['consumerLag', 'totalLag', 'lag'], label: { a: 'Topic', b: '消费堆积' } },
  rabbitmq: { a: ['queues', 'queueTotal', 'queueCount'], b: ['messagesReady', 'ready', 'messages_ready'], c: ['consumers', 'consumerTotal'], label: { a: '队列', b: '就绪', c: '消费者' } },
  mqtt: { a: ['connections', 'clients', 'clientCount', 'liveConnections'], b: ['subscriptions', 'subscriptionCount'], c: ['retained', 'retainedCount', 'retainedMessages'], label: { a: '连接', b: '订阅', c: 'retained' } },
  rocketmq: { a: ['topics', 'topicCount'], b: ['groups', 'consumerGroupCount', 'consumerGroups'], c: ['consumerLag', 'totalLag', 'diff'], label: { a: 'Topic', b: '消费组', c: '堆积' } }
}

function metricValue(metrics, keys) {
  for (const k of keys || []) {
    const v = metrics?.[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return null
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
  home.innerHTML = `
    <h1>中间件控制台</h1>
    <div class="sub">Kafka · RabbitMQ · MQTT · RocketMQ 统一管理 —— 连接、Topic、消息溯源、消费组与监控</div>
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

function isBigLag(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 5000
}

/** 卡片 3 格指标（overview 未到达时画骨架 — ） */
function renderCardMetrics(card, conn, overview) {
  const metricsEl = card.querySelector('[data-el=metrics]')
  const keys = METRIC_KEYS[conn.kind] || {}
  const metrics = overview?.metrics || {}
  metricsEl.innerHTML = ''
  const defs = [
    { raw: metricValue(metrics, keys.a), label: keys.label?.a ?? '指标', warn: false },
    { raw: metricValue(metrics, keys.b), label: keys.label?.b ?? '指标', warn: isBigLag(metricValue(metrics, keys.b)) },
    { raw: metricValue(metrics, keys.c), label: keys.label?.c ?? '指标', warn: isBigLag(metricValue(metrics, keys.c)) }
  ]
  for (const d of defs) {
    const m = document.createElement('div')
    m.className = 'm'
    const text = d.raw === null || d.raw === undefined || d.raw === '' ? '—' : fmt.compact(d.raw)
    m.innerHTML = `<div class="k">${esc(d.label)}</div><div class="v ${d.warn ? 'warn' : ''}">${esc(text)}</div>`
    metricsEl.appendChild(m)
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
  else footLeft.textContent = `经 rocketmq-dashboard${conn.readOnly ? ' · 🔒 只读' : ''}`
}

/** 连接配置变化后清首页缓存 */
export function invalidateHomeCache(connId) {
  if (connId === undefined) homeOverviewCache.clear()
  else homeOverviewCache.delete(connId)
}
