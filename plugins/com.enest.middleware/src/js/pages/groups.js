/** 消费组·订阅·客户端页：kafka/rocketmq=消费组+offsets；rabbitmq=队列伪分组+connections；mqtt=EMQX 客户端 */
import {
  fmt, chip, el, gate, lagBar, escapeHtml,
  simpleGrid, confirmDanger, infoDialog, showContextMenu
} from '../components.js'

/* —— 表单原子（与 topics.js 同风格）—— */
function fieldRow(label, input, tip) {
  const row = el('div', { class: 'form-row' }, [el('label', {}, label), input])
  if (tip) row.appendChild(el('div', { class: 'tip' }, tip))
  return row
}
function textInput(attrs = {}) { return el('input', { type: 'text', autocomplete: 'off', ...attrs }) }
function numInput(value, attrs = {}) { return el('input', { type: 'number', value: String(value), ...attrs }) }
function dialogButtons(dlg, { submitLabel = '确定', onSubmit, danger = false }) {
  const box = dlg.footer.firstElementChild
  const cancel = el('button', { class: 'btn', onclick: () => dlg.close() }, '取消')
  const ok = el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => onSubmit() }, submitLabel)
  box.append(cancel, ok)
}
function stateChip(state) {
  if (!state) return '<span style="color:var(--text-3)">—</span>'
  const s = String(state).toLowerCase()
  const cls = /stable|ok|empty|running/.test(s) ? 'ok' : /rebalanc|prepar|complet/.test(s) ? 'warn' : /dead|error/.test(s) ? 'bad' : ''
  return chip(String(state), cls)
}

/* 模块级实例清理句柄：路由 destroy() 时回调（避免 this 绑定歧义） */
let activeCleanup = null

export default {
  id: 'groups',
  render(root, ctx) {
    const { api, conn, caps, mode } = ctx
    const kind = conn?.kind ?? 'kafka'
    const isRmq = kind === 'rabbitmq'
    const isMqtt = kind === 'mqtt'
    const isKafkaLike = !isRmq && !isMqtt // kafka / rocketmq

    const clampRows = (rows) => (mode === 'quick' ? rows.slice(0, 200) : rows)
    const writeGuard = () => {
      if (conn?.readOnly) return { blocked: true, reason: '只读连接，写操作被宿主拦截' }
      if (mode === 'quick') return { blocked: true, reason: 'quick 模式只读' }
      return { blocked: false }
    }

    root.innerHTML = ''
    let destroyed = false
    let allRows = []
    let keyword = ''

    const loading = el('div', { class: 'loading-bar' })
    const search = el('input', {
      placeholder: isKafkaLike ? '搜索消费组…' : isMqtt ? '搜索 clientId…' : '搜索…',
      oninput: (e) => { keyword = e.target.value.trim().toLowerCase(); applyFilter() }
    })
    const refreshBtn = el('button', { class: 'btn ghost', title: '刷新', onclick: () => load() }, '⟳')
    const count = el('span', { class: 'count' })
    const toolbar = el('div', { class: 'toolbar' }, [
      el('div', { class: 'search' }, ['🔍', search]),
      refreshBtn,
      count
    ])
    const gridHost = el('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' })
    root.append(toolbar, loading, gridHost)
    let viewSegment = 'groups' // rmq: groups | clients

    /* —— mqtt 无 EMQX：整页降级 —— */
    const clientsCap = gate(caps, 'clients')
    if (isMqtt && !clientsCap.enabled) {
      root.innerHTML = ''
      root.appendChild(el('div', { class: 'empty-cap' }, [
        el('div', { class: 'big' }, '◐'),
        el('div', { style: 'max-width:420px;line-height:1.8;margin-bottom:6px' },
          '该 MQTT 连接未启用 EMQX 管理适配，无法列出客户端与订阅关系。'),
        el('div', { style: 'color:var(--text-3);font-size:11.5px;margin-bottom:14px' },
          clientsCap.reason || '编辑连接并填写 EMQX 管理端点后可获得客户端管理能力'),
        el('button', { class: 'btn', onclick: () => load() }, '⟳ 重试')
      ]))
      activeCleanup = () => { destroyed = true }
      return
    }

    let grid = null

    function rebuild(columns, { onRowClick, onRowCtx, emptyText } = {}) {
      grid = simpleGrid({ columns, rowKey: (r) => r.groupId ?? r.clientId ?? r.__key ?? JSON.stringify(r), onRowClick, onRowCtx, emptyText })
      gridHost.innerHTML = ''
      gridHost.appendChild(grid.root)
      applyFilter()
    }

    function buildGrid() {
      if (isKafkaLike) {
        rebuild([
          { key: 'groupId', title: '消费组', mono: true, width: '28%' },
          { key: 'state', title: '状态', render: (r) => stateChip(r.state) },
          { key: 'members', title: '成员', num: true, render: (r) => r.members != null ? fmt.num(r.members) : '—' },
          { key: 'totalLag', title: '总堆积', render: (r) => lagBar(r.totalLag) },
          { key: 'topics', title: '订阅 Topic', num: true, render: (r) => r.topics != null ? fmt.num(r.topics.length ?? r.topics) : '—' }
        ], {
          onRowClick: (row) => openGroupDetail(row),
          onRowCtx: groupCtx,
          emptyText: '暂无消费组'
        })
        return
      }
      if (isRmq && viewSegment === 'clients') {
        rebuild([
          { key: 'clientId', title: '连接（Client ID）', mono: true, width: '30%', render: (r) => escapeHtml(String(r.clientId ?? r.name ?? '—')) },
          { key: 'host', title: '来源地址', mono: true, render: (r) => escapeHtml(String(r.host ?? r.extras?.peerHost ?? '—')) },
          { key: 'connectedAt', title: '连接时间', render: (r) => fmt.datetime(r.connectedAt) },
          { key: 'subscriptionsCount', title: 'Channel/订阅', num: true, render: (r) => fmt.num(r.subscriptionsCount ?? r.extras?.channels) },
          { key: 'state', title: '状态', render: (r) => stateChip(r.state ?? r.extras?.state) }
        ], {
          onRowCtx: clientCtx,
          emptyText: '暂无连接'
        })
        return
      }
      if (isRmq) {
        // 伪分组（按队列聚合的消费者）
        rebuild([
          { key: 'groupId', title: '队列（伪分组）', mono: true, width: '28%', render: (r) => escapeHtml(String(r.groupId ?? r.name ?? '—')) },
          { key: 'consumerCount', title: '消费者', num: true, render: (r) => fmt.num(r.consumerCount ?? r.members ?? 0) },
          { key: 'messageCount', title: '消息数', num: true, render: (r) => fmt.compact(r.messageCount) },
          { key: 'ready', title: '就绪', num: true, render: (r) => fmt.num(r.extras?.ready) },
          { key: 'ack', title: '未确认', num: true, render: (r) => fmt.num(r.extras?.unacked ?? r.extras?.messagesUnacknowledged) }
        ], {
          onRowCtx: rmqGroupCtx,
          emptyText: '暂无消费者分组'
        })
        return
      }
      // mqtt 客户端
      rebuild([
        { key: 'clientId', title: 'Client ID', mono: true, width: '30%' },
        { key: 'host', title: '来源地址', mono: true, render: (r) => escapeHtml(String(r.host ?? '—')) },
        { key: 'connectedAt', title: '连接时间', render: (r) => fmt.datetime(r.connectedAt) },
        { key: 'subscriptionsCount', title: '订阅数', num: true, render: (r) => fmt.num(r.subscriptionsCount) }
      ], {
        onRowCtx: clientCtx,
        emptyText: '暂无客户端'
      })
    }

    /* —— 数据加载 —— */
    async function load() {
      if (loading.parentNode !== root) root.insertBefore(loading, gridHost)
      try {
        let rows = []
        if (viewSegment === 'clients') {
          const res = await api.mw('clients.list', { sessionKey: ctx.sessionKey })
          rows = Array.isArray(res) ? res : res?.items ?? res?.clients ?? []
        } else {
          const res = await api.mw('groups.list', { sessionKey: ctx.sessionKey })
          rows = Array.isArray(res) ? res : res?.items ?? res?.groups ?? []
        }
        if (destroyed) return
        allRows = clampRows(rows)
        applyFilter()
      } catch (err) {
        if (destroyed) return
        api.toast(err?.message || String(err), 'error')
        allRows = []
        applyFilter()
      } finally {
        loading.remove()
      }
    }

    /* —— rmq 分段切换：groups | clients —— */
    if (isRmq) {
      const seg = el('div', { class: 'seg' }, ['groups', 'clients'].map((s) => el('button', {
        class: s === 'groups' ? 'on' : '',
        onclick: (e) => {
          viewSegment = s
          e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('on'))
          e.currentTarget.classList.add('on')
          if (s === 'clients') {
            const g = gate(caps, 'clients')
            if (!g.enabled) return api.toast(g.reason, 'warn')
          }
          buildGrid()
          load()
        }
      }, { groups: '消费者', clients: '连接' }[s])))
      toolbar.insertBefore(seg, refreshBtn)
      const clientsGate = gate(caps, 'clients')
      if (!clientsGate.enabled) {
        seg.lastElementChild.disabled = true
        seg.lastElementChild.title = clientsGate.reason
      }
    }

    function applyFilter() {
      const field = (r) => String(r.groupId ?? r.clientId ?? r.name ?? '').toLowerCase()
      const rows = keyword ? allRows.filter((r) => field(r).includes(keyword)) : allRows
      grid?.update(rows)
      const unit = viewSegment === 'clients'
        ? (isRmq ? '个连接' : '个客户端')
        : (isKafkaLike ? '个消费组' : '个分组')
      count.innerHTML = `共 <b>${fmt.num(rows.length)}</b> ${unit}`
    }

    /* —— 右键菜单 —— */
    function item(label, icon, opts = {}) {
      let disabled = false
      let reason = ''
      if (opts.capKey) {
        const g = gate(caps, opts.capKey)
        if (!g.enabled) { disabled = true; reason = g.reason }
      }
      if ((opts.danger || opts.write) && !disabled) {
        const wg = writeGuard()
        if (wg.blocked) { disabled = true; reason = wg.reason }
      }
      if (opts.disabled) { disabled = true; reason = opts.reason ?? '不可用' }
      return { label, icon, danger: opts.danger, disabled, reason, onClick: opts.onClick }
    }

    function groupCtx(e, row) {
      showContextMenu(e.clientX, e.clientY, [
        item('详情 · offsets 明细', '📄', { onClick: () => openGroupDetail(row) }),
        item('重置 Offset…', '↺', {
          capKey: 'offsetReset',
          onClick: () => resetOffsets(row)
        })
      ])
    }

    function rmqGroupCtx(e, row) {
      showContextMenu(e.clientX, e.clientY, [
        item('重置 Offset…', '↺', {
          disabled: true,
          reason: 'AMQP 模型无 offset',
          onClick: () => {}
        })
      ])
    }

    function clientCtx(e, row) {
      showContextMenu(e.clientX, e.clientY, [
        item(isRmq ? '断开连接…' : '踢出客户端…', '⛔', {
          capKey: 'clientKick',
          danger: true,
          onClick: () => kickClient(row)
        })
      ])
    }
    /* —— 消费组详情（offsets 明细）—— */
    async function openGroupDetail(row) {
      const dlg = infoDialog({ title: `消费组 · ${row.groupId}`, width: 680 })
      dlg.body.appendChild(el('div', { class: 'loading-bar' }))
      let offsets = []
      try {
        const res = await api.mw('group.describe', { sessionKey: ctx.sessionKey, groupId: row.groupId })
        offsets = res?.offsets ?? res?.partitions ?? res?.items ?? (Array.isArray(res) ? res : [])
      } catch (err) {
        api.toast(err?.message || String(err), 'error')
        dlg.close()
        return
      }
      dlg.body.innerHTML = ''
      const summary = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' }, [
        stateChip(row.state),
        chip(`成员 ${fmt.num(row.members)}`),
        chip(`总堆积 ${fmt.compact(row.totalLag)}`),
        row.topics?.length ? chip(`Topic ${fmt.num(row.topics.length)}`) : ''
      ])
      dlg.body.appendChild(summary)
      const offsetGrid = simpleGrid({
        columns: [
          { key: 'topic', title: 'Topic', mono: true, width: '32%', render: (r) => escapeHtml(String(r.topic ?? '—')) },
          { key: 'partition', title: '分区', num: true, width: '70px', render: (r) => escapeHtml(String(r.partition ?? '—')) },
          { key: 'offset', title: '当前 Offset', num: true, render: (r) => fmt.num(r.offset ?? r.currentOffset) },
          { key: 'endOffset', title: '末端 Offset', num: true, render: (r) => fmt.num(r.endOffset ?? r.logEndOffset) },
          { key: 'lag', title: 'Lag', num: true, render: (r) => fmt.num(r.lag) }
        ],
        rowKey: (r) => `${r.topic}-${r.partition}`,
        emptyText: '无 offset 明细'
      })
      offsetGrid.root.style.maxHeight = '320px'
      offsetGrid.update(offsets)
      dlg.body.appendChild(offsetGrid.root)
      const box = dlg.footer.firstElementChild
      box.appendChild(el('button', { class: 'btn', onclick: () => dlg.close() }, '关闭'))
    }

    /* —— 重置 offset（两段式）—— */
    async function resetOffsets(row) {
      const wg = writeGuard()
      if (wg.blocked) return api.toast(wg.reason, 'warn')

      const dlg = infoDialog({ title: `重置 Offset · ${row.groupId}`, width: 480 })
      dlg.body.appendChild(el('div', { class: 'form-note', style: 'margin-top:0' }, [
        el('span', {}, '⚠️'),
        el('span', { html: '重置 offset 会改变消费位点，<b>需组内无活跃消费者</b>，否则可能触发重复消费或丢消息。' })
      ]))
      const topicNames = Array.isArray(row.topics)
        ? row.topics.map((t) => (typeof t === 'string' ? t : t?.topic ?? t?.name)).filter(Boolean)
        : []
      const topicSel = el('select', {}, topicNames.length
        ? topicNames.map((t) => el('option', { value: t }, t))
        : [el('option', { value: '' }, '（未获取到订阅 Topic，手动输入）')])
      const topicInput = textInput({ placeholder: 'topic 名称（当下拉为空时填写）', style: 'margin-top:8px' })
      dlg.body.appendChild(fieldRow('Topic', topicSel))
      dlg.body.appendChild(topicInput)
      const modeSeg = el('div', { class: 'seg' })
      const modes = ['earliest', 'latest', 'timestamp']
      let mode = 'earliest'
      modeSeg.append(...modes.map((m) => el('button', {
        class: m === 'earliest' ? 'on' : '',
        onclick: (e) => {
          mode = m
          e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('on'))
          e.currentTarget.classList.add('on')
          tsRow.style.display = m === 'timestamp' ? '' : 'none'
        }
      }, { earliest: 'earliest', latest: 'latest', timestamp: 'timestamp' }[m])))
      dlg.body.appendChild(fieldRow('重置方式', modeSeg))
      const tsInput = numInput(Date.now(), { style: 'width:100%' })
      const tsRow = fieldRow('时间戳（ms）', tsInput, '重置到该时间之后的第一条消息')
      tsRow.style.display = 'none'
      dlg.body.appendChild(tsRow)
      dialogButtons(dlg, {
        submitLabel: '下一步',
        onSubmit: async () => {
          const topic = topicSel.value || topicInput.value.trim()
          if (!topic) { topicInput.focus(); api.toast('请选择或输入 Topic', 'warn'); return }
          let payload = { sessionKey: ctx.sessionKey, groupId: row.groupId, topic }
          if (mode === 'timestamp') {
            const ts = Number(tsInput.value)
            if (!Number.isFinite(ts) || ts <= 0) { tsInput.focus(); return }
            payload = { ...payload, timestamp: ts }
          } else payload = { ...payload, strategy: mode }
          dlg.close()
          const ok = await confirmDanger({
            title: '确认重置 Offset',
            message: `消费组 <b>${escapeHtml(String(row.groupId))}</b> 在 <b>${escapeHtml(topic)}</b> 上的位点将重置为 <b>${mode}</b>。执行前请确认组内无活跃消费者。`,
            requireText: String(row.groupId),
            confirmLabel: '重置'
          })
          if (!ok) return
          try {
            await api.mw('group.resetOffsets', payload)
            api.toast('已重置 offset', 'success')
            load()
          } catch (err) { api.toast(err?.message || String(err), 'error') }
        }
      })
    }

    /* —— 踢出/断开 —— */
    async function kickClient(row) {
      const wg = writeGuard()
      if (wg.blocked) return api.toast(wg.reason, 'warn')
      const ok = await confirmDanger({
        title: isRmq ? '断开连接' : '踢出客户端',
        message: `将断开 <b>${escapeHtml(String(row.clientId))}</b>（${escapeHtml(String(row.host ?? ''))}），其订阅与未确认消息将由 broker 依策略处理。`,
        requireText: String(row.clientId),
        confirmLabel: isRmq ? '断开' : '踢出'
      })
      if (!ok) return
      try {
        await api.mw('client.kick', { sessionKey: ctx.sessionKey, clientId: row.clientId })
        api.toast('已断开', 'success')
        load()
      } catch (err) { api.toast(err?.message || String(err), 'error') }
    }

    buildGrid()
    load()
    activeCleanup = () => { destroyed = true }
  },
  destroy() { activeCleanup?.(); activeCleanup = null }
}
