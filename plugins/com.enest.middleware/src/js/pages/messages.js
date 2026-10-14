/** 消息浏览器：过滤查询 / 详情面板 / 重发 / 实时监听（视觉基准 = design/concept.html 页面 ③） */
import { fmt, el, chip, simpleGrid, infoDialog, payloadHighlight, escapeHtml, showContextMenu } from '../components.js'

const TOPIC_LABEL = { kafka: 'Topic', rabbitmq: '队列', mqtt: 'Topic 过滤', rocketmq: 'Topic' }
const MODE_LABEL = { offset: '按 Offset', timestamp: '按时间', key: '按 Key', id: '按 MsgId' }
// 会话未回填 queryModes 时的静态兜底（与 kinds 描述符语义一致）
const DEFAULT_MODES = { kafka: ['offset', 'timestamp', 'key'], rocketmq: ['timestamp', 'key', 'id'] }
const MAX_ROWS = 200 // quick 模式数据钳制上限，同时是监听缓冲上限

function short(value, n = 40) {
  const s = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return s.length > n ? s.slice(0, n) + '…' : s
}
function preview80(m) {
  const flat = String(m.payload ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? flat.slice(0, 80) + '…' : flat
}
function localInputValue(ts) {
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export default {
  id: 'messages',

  render(root, ctx) {
    const { api, conn } = ctx
    const kind = conn.kind
    const modes = ctx.queryModes?.length ? ctx.queryModes : (DEFAULT_MODES[kind] ?? [])
    let locate = modes[0] ?? null // 'offset' | 'timestamp' | 'key' | 'id' | null(rmq/mqtt 无定位)
    let rows = []
    let selected = null
    let tail = null // { tailId, unsub, paused, count }

    /* —— LIVE 条（未监听时隐藏）—— */
    const liveInfo = el('span', { class: 'info' }, '')
    const pauseBtn = el('button', { class: 'btn ghost sm', onclick: togglePause }, '⏸ 暂停')
    const liveBar = el('div', { class: 'live-bar', style: 'display:none' }, [
      el('span', { class: 'live-dot' }),
      el('span', { class: 'live-tag' }, 'LIVE'),
      liveInfo,
      el('span', { class: 'grow' }),
      pauseBtn,
      el('button', { class: 'btn ghost sm', onclick: () => { rows = []; grid.update([]); } }, '清空'),
      el('button', { class: 'btn danger sm', onclick: () => stopTail(true) }, '停止监听')
    ])

    /* —— 过滤栏 —— */
    const topicList = el('datalist', { id: 'mw-topic-list' })
    const topicInput = el('input', {
      type: 'text', list: 'mw-topic-list', placeholder: TOPIC_LABEL[kind] + '，可手输',
      style: 'width:200px', autocomplete: 'off',
      onchange: () => { if (kind === 'kafka') loadPartitions(topicInput.value.trim()) }
    })
    const seg = modes.length
      ? el('div', { class: 'seg' }, modes.map((m, i) => el('button', {
          class: i === 0 ? 'on' : '',
          onclick: (e) => {
            locate = m
            seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget))
            syncLocate()
          }
        }, MODE_LABEL[m] ?? m)))
      : null
    const partsSel = el('select', { onchange: () => {} }, [el('option', { value: 'all' }, '全部')])
    const offsetIn = el('input', { type: 'number', value: '0', style: 'width:96px' })
    const timeIn = el('input', { type: 'datetime-local', value: localInputValue(Date.now() - 15 * 60 * 1000), style: 'width:194px' })
    const textIn = el('input', { type: 'text', placeholder: '匹配 Key', style: 'width:150px', autocomplete: 'off' })
    const maxSel = el('select', {}, ['50', '100', '200'].map((n) => el('option', { value: n }, n)))
    const countSpan = el('span', { style: 'color:var(--text-3);font-size:12px' }, '')
    const tailBtn = el('button', { class: 'btn ghost', style: 'margin-left:auto', onclick: startTail }, '📥 从查询结果转入监听')

    const kindChips = []
    if (kind === 'rabbitmq') kindChips.push(el('span', { html: chip('peek 模式：消息将被 requeue', 'warn', 'RabbitMQ 经管理面取队头消息，取出后 requeue 回队列') }))
    if (kind === 'mqtt') kindChips.push(el('span', { html: chip('retained：仅保留消息快照', '', '通用 MQTT 无历史消息，只能读取 retained 消息') }))

    const filterBar = el('div', { class: 'filter-bar' }, [
      el('span', { class: 'fld' }, [TOPIC_LABEL[kind] + ' ', topicInput]),
      ...kindChips,
      seg,
      ...(kind === 'kafka' ? [el('span', { class: 'fld' }, ['分区 ', partsSel])] : []),
      el('span', { class: 'fld' }, ['起点 ', offsetIn]),
      el('span', { class: 'fld' }, ['起点 ', timeIn]),
      el('span', { class: 'fld' }, ['匹配 ', textIn]),
      el('span', { class: 'fld' }, ['条数 ', maxSel]),
      el('button', { class: 'btn primary', onclick: doQuery }, '查询'),
      countSpan,
      tailBtn
    ])

    /* —— 左表 + 右详情 —— */
    const columns = [
      { key: 'offset', title: 'OFFSET', num: true, width: '96px', render: (m) => m.offset != null ? fmt.num(m.offset) : escapeHtml(short(m.messageId ?? '—', 18)) },
      { title: '时间', width: '158px', render: (m) => `<span style="font-family:var(--mono);font-size:12px">${escapeHtml(fmt.datetimeMs(m.timestamp))}</span>` },
      { title: 'KEY', width: '108px', render: (m) => escapeHtml(short(m.key ?? '', 16)) },
      { title: 'PAYLOAD 预览', mono: true, render: (m) => escapeHtml(preview80(m)) }
    ]
    const grid = simpleGrid({
      columns,
      rowKey: (m) => m.__rid,
      onRowClick: (m) => { selected = m; renderDetail(m) },
      onRowCtx: (e, m) => {
        selected = m; renderDetail(m)
        showMsgMenu(e, m)
      },
      emptyText: '输入条件后点击「查询」'
    })
    grid.root.style.padding = '0'
    const tablePane = el('div', { class: 'msg-table' }, [grid.root])

    const copyBtn = el('button', { class: 'btn sm', onclick: () => {
      if (!selected) return
      api.copy(JSON.stringify(selected, null, 2)).then(() => api.toast('已复制消息全文 JSON', 'success'), () => api.toast('复制失败', 'error'))
    } }, '⧉ 复制')
    const resendBtn = el('button', { class: 'btn accent sm write', onclick: () => selected && openResend(selected) }, '↪ 重发…')
    const metaDiv = el('div', { class: 'meta' })
    const payloadPane = el('div', { class: 'payload-pane' })
    const viewer = el('aside', { class: 'msg-viewer' }, [
      el('div', { class: 'vh' }, ['消息详情', el('span', { class: 'grow' }), copyBtn, resendBtn]),
      metaDiv,
      payloadPane
    ])

    const loading = el('div', { class: 'loading-bar', style: 'display:none' })
    root.append(liveBar, filterBar, loading, el('div', { class: 'msg-split' }, [tablePane, viewer]))
    root.appendChild(topicList)
    renderEmptyDetail()
    syncLocate()

    /* —— 下拉 / 分区懒加载 —— */
    loadTopicOptions()
    async function loadTopicOptions() {
      try {
        const res = await api.mw('topics.list', {})
        const list = Array.isArray(res) ? res : (res?.topics ?? res?.items ?? [])
        topicList.innerHTML = ''
        for (const t of list) {
          const name = typeof t === 'string' ? t : t?.name
          if (name) topicList.appendChild(el('option', { value: name }))
        }
      } catch (e) { api.toast(`Topic 列表加载失败：${e.message}`, 'error') }
    }
    async function loadPartitions(topic) {
      partsSel.innerHTML = ''
      partsSel.appendChild(el('option', { value: 'all' }, '全部'))
      if (!topic) return
      try {
        const res = await api.mw('topic.describe', { topic })
        const n = Number(res?.partitions ?? res?.topic?.partitions ?? res?.partitionCount ?? 0)
        for (let i = 0; i < n; i++) partsSel.appendChild(el('option', { value: String(i) }, String(i)))
      } catch { /* 分区信息缺失不阻塞查询，保持「全部」 */ }
    }

    function syncLocate() {
      offsetIn.parentElement.style.display = locate === 'offset' ? '' : 'none'
      timeIn.parentElement.style.display = locate === 'timestamp' ? '' : 'none'
      if (locate === 'key' || locate === 'id') {
        textIn.parentElement.style.display = ''
        textIn.placeholder = locate === 'key' ? '匹配 Key' : 'MsgId'
      } else textIn.parentElement.style.display = 'none'
    }

    /* —— 查询 —— */
    async function doQuery() {
      const topic = topicInput.value.trim()
      if (!topic) { api.toast(`请先填写 ${TOPIC_LABEL[kind]}`, 'warn'); return }
      const input = { topic, max: Number(maxSel.value), surface: ctx.mode }
      if (kind === 'kafka' && partsSel.value !== 'all') input.partition = Number(partsSel.value)
      if (locate === 'offset') { input.from = 'offset'; input.offset = Number(offsetIn.value) || 0 }
      else if (locate === 'timestamp') {
        const ts = new Date(timeIn.value).getTime()
        if (!Number.isFinite(ts)) { api.toast('请选择起始时间', 'warn'); return }
        input.from = 'timestamp'; input.timestamp = ts
      } else if (locate === 'key') {
        if (!textIn.value.trim()) { api.toast('请输入匹配 Key', 'warn'); return }
        input.from = 'key'; input.key = textIn.value.trim()
      } else if (locate === 'id') {
        if (!textIn.value.trim()) { api.toast('请输入 MsgId', 'warn'); return }
        input.from = 'id'; input.messageId = textIn.value.trim()
      }
      loading.style.display = ''
      try {
        const res = await api.mw('messages.query', input)
        const list = Array.isArray(res) ? res : (res?.messages ?? res?.items ?? [])
        rows = list.slice(0, MAX_ROWS)
        stampRids(rows)
        grid.update(rows)
        countSpan.textContent = rows.length ? `共 ${rows.length} 条` : ''
        if (rows.length) { selected = rows[0]; grid.setSelected(rows[0].__rid); renderDetail(rows[0]) }
        else { selected = null; renderEmptyDetail() }
      } catch (e) {
        api.toast(e.message, 'error')
        rows = []; grid.update([]); countSpan.textContent = ''; selected = null; renderEmptyDetail()
      } finally { loading.style.display = 'none' }
    }
    function stampRids(list) {
      list.forEach((m, i) => { m.__rid = `${m.messageId ?? ''}|${m.offset ?? ''}|${m.timestamp ?? ''}|${i}` })
    }

    /* —— 详情面板 —— */
    function renderEmptyDetail() {
      selected = null
      metaDiv.innerHTML = '<span class="k">提示</span><span class="v" style="font-family:var(--font)">选择左侧消息查看详情</span>'
      payloadPane.innerHTML = ''
    }
    function renderDetail(m) {
      metaDiv.innerHTML = ''
      const row = (k, vHtml) => { metaDiv.insertAdjacentHTML('beforeend', `<span class="k">${escapeHtml(k)}</span><span class="v">${vHtml}</span>`) }
      row('topic / partition', escapeHtml(String(m.topic ?? '—')) + (m.partition != null ? ` / ${escapeHtml(String(m.partition))}` : ''))
      if (m.offset != null) row('offset', escapeHtml(fmt.num(m.offset)))
      if (m.messageId != null) row('messageId', escapeHtml(short(m.messageId, 64)))
      row('timestamp', escapeHtml(fmt.datetimeMs(m.timestamp)))
      if (m.key != null && m.key !== '') row('key', escapeHtml(String(m.key)))
      if (m.redelivered != null) row('redelivered', m.redelivered ? '是' : '否')
      if (m.payloadBytes != null) row('大小', escapeHtml(fmt.bytes(m.payloadBytes)))
      const kvChips = (obj) => Object.entries(obj ?? {}).map(([k, v]) => chip(`${k}=${short(v, 36)}`)).join('') || '—'
      row('headers', kvChips(m.headers))
      row('properties', kvChips(m.properties))
      for (const [k, v] of Object.entries(m.extras ?? {})) row(k, escapeHtml(short(v, 80)))
      payloadPane.innerHTML = payloadHighlight(m.payload)
    }

    /* —— 右键菜单（复制 / 重发入口冗余）—— */
    function showMsgMenu(e, m) {
      showContextMenu(e.clientX, e.clientY, [
        { label: '⧉ 复制全文 JSON', onClick: () => api.copy(JSON.stringify(m, null, 2)).then(() => api.toast('已复制', 'success'), () => {}) },
        { label: '↪ 重发…', onClick: () => openResend(m) }
      ])
    }

    /* —— 重发弹窗（写操作：readOnly / quick 直接拒绝）—— */
    function openResend(m) {
      if (conn.readOnly || ctx.mode === 'quick') { api.toast('只读连接（或 quick 模式）禁止重发', 'error'); return }
      const dlg = infoDialog({ title: '重发消息', width: 560 })
      const topicIn = el('input', { type: 'text', value: String(m.topic ?? ''), autocomplete: 'off' })
      const bodyRows = [el('div', { class: 'form-row' }, [el('label', {}, `目标 ${TOPIC_LABEL[kind]}`), topicIn])]
      if (kind === 'rabbitmq') {
        bodyRows.push(el('div', { class: 'form-row' }, [
          el('label', {}, 'Routing Key'),
          el('input', { type: 'text', value: String(m.key ?? ''), autocomplete: 'off' }),
          el('div', { class: 'tip' }, '经默认交换机按队列名路由，routing key 留空则按目标队列名投递')
        ]))
      }
      const payloadIn = el('textarea', { rows: '8' })
      payloadIn.value = String(m.payload ?? '')
      bodyRows.push(el('div', { class: 'form-row' }, [el('label', {}, 'Payload（可编辑）'), payloadIn]))
      dlg.body.append(...bodyRows)

      const bar = dlg.footer?.firstElementChild ?? dlg.footer
      const cancel = el('button', { class: 'btn', onclick: () => dlg.close() }, '取消')
      const ok = el('button', {
        class: 'btn accent write',
        onclick: async () => {
          const target = topicIn.value.trim()
          if (!target) { api.toast('请填写目标', 'warn'); return }
          ok.disabled = true
          try {
            const input = { topic: target, payload: payloadIn.value, headers: m.headers ?? undefined, properties: m.properties ?? undefined }
            if (m.key != null && m.key !== '') input.key = String(m.key)
            if (kind === 'rabbitmq') input.routingKey = dlg.body.querySelectorAll('input')[1]?.value?.trim() ?? ''
            await api.mw('messages.resend', input)
            api.toast(`已重发到 ${target}`, 'success')
            dlg.close()
          } catch (e) { api.toast(e.message, 'error'); ok.disabled = false }
        }
      }, '确认重发')
      bar.append(cancel, ok)
    }

    /* —— 实时监听 —— */
    async function startTail() {
      if (tail) return
      const topic = topicInput.value.trim()
      if (!topic) { api.toast(`请先填写 ${TOPIC_LABEL[kind]}`, 'warn'); return }
      const tailId = `tail-${Date.now()}`
      // 订阅必须先于 tail.start 建立，否则早期事件丢失
      const unsub = api.onMwData((data) => {
        if (!tail || data?.sessionKey !== ctx.sessionKey || data?.tailId !== tailId) return
        onTailMessage(data.message)
      })
      tail = { tailId, unsub, paused: false, count: 0 }
      try {
        const filter = (locate === 'key' && textIn.value.trim()) ? textIn.value.trim() : undefined
        await api.mw('tail.start', { sessionKey: ctx.sessionKey, tailId, topic, filter })
        liveBar.style.display = ''
        tailBtn.disabled = true
        updateLiveInfo(topic)
      } catch (e) {
        unsub(); tail = null
        api.toast(e.message, 'error')
      }
    }
    function onTailMessage(m) {
      if (!m) return
      tail.count++
      rows.unshift(m)
      if (rows.length > MAX_ROWS) rows.length = MAX_ROWS
      stampRids(rows)
      if (!tail.paused) grid.update(rows) // 暂停=只停渲染不清流
      updateLiveInfo(topicInput.value.trim())
    }
    function updateLiveInfo(topic) {
      liveInfo.innerHTML = `正在实时监听 <b>${escapeHtml(topic)}</b> · 已接收 ${fmt.num(tail.count)} 条`
    }
    function togglePause() {
      if (!tail) return
      tail.paused = !tail.paused
      pauseBtn.textContent = tail.paused ? '▶ 继续' : '⏸ 暂停'
      if (!tail.paused) grid.update(rows)
    }
    async function stopTail(callStop) {
      if (!tail) return
      const { tailId, unsub } = tail
      tail = null
      unsub()
      liveBar.style.display = 'none'
      tailBtn.disabled = false
      pauseBtn.textContent = '⏸ 暂停'
      if (callStop) {
        try { await api.mw('tail.stop', { sessionKey: ctx.sessionKey, tailId }) } catch { /* 会话可能已关闭 */ }
      }
    }

    this.__stop = () => stopTail(true)
  },

  destroy() {
    this.__stop?.()            // tail.stop（会话已关时静默）+ 取消订阅 + 清空 live 状态
  }
}
