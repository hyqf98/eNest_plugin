/** Topic·队列页：列定义从驱动 pageColumns 描述符渲染（kafka/rocketmq=topics；rabbitmq=queues/exchanges/bindings；mqtt=订阅降级） */
import {
  fmt, chip, el, gate, capTitle, escapeHtml, columnsFromSpec,
  simpleGrid, confirmDanger, infoDialog, showContextMenu
} from '@mw/components.js'
import { pageColumnsOf } from '@mw/kinds.js'

/* —— 表单原子 —— */
function fieldRow(label, input, tip) {
  const row = el('div', { class: 'form-row' }, [el('label', {}, label), input])
  if (tip) row.appendChild(el('div', { class: 'tip' }, tip))
  return row
}
function switchRow(label, initial) {
  const sw = el('button', { class: `switch ${initial ? 'on' : ''}`, type: 'button' })
  const state = { value: !!initial }
  sw.addEventListener('click', () => { state.value = !state.value; sw.classList.toggle('on', state.value) })
  const row = el('div', { class: 'switch-row' }, [sw, el('span', { class: 'sl' }, label)])
  return { row, get: () => state.value }
}
function dialogButtons(dlg, { submitLabel = '确定', onSubmit, danger = false }) {
  const box = dlg.footer.firstElementChild
  const cancel = el('button', { class: 'btn', onclick: () => dlg.close() }, '取消')
  const ok = el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => onSubmit() }, submitLabel)
  box.append(cancel, ok)
}
function textInput(attrs = {}) { return el('input', { type: 'text', autocomplete: 'off', ...attrs }) }
function numInput(value, attrs = {}) { return el('input', { type: 'number', value: String(value), ...attrs }) }

export default {
  id: 'topics',
  render(root, ctx) {
    const { api, conn, caps, mode } = ctx
    const kind = conn?.kind ?? 'kafka'
    const isRmq = kind === 'rabbitmq'
    const isMqtt = kind === 'mqtt'
    const crud = () => gate(caps, 'topicCrud')
    const writeGuard = () => {
      if (conn?.readOnly) return { blocked: true, reason: '只读连接，写操作被宿主拦截' }
      if (mode === 'quick') return { blocked: true, reason: 'quick 模式只读' }
      return { blocked: false }
    }
    const clampRows = (rows) => (mode === 'quick' ? rows.slice(0, 200) : rows)

    root.innerHTML = ''
    let destroyed = false
    let segment = isRmq ? 'queues' : 'topics' // queues|exchanges|bindings|topics|subscriptions
    let allRows = []
    let keyword = ''

    const loading = el('div', { class: 'loading-bar' })
    const searchLabel = isRmq ? '筛选名称' : '筛选 Topic 名称'
    const search = el('input', {
      type: 'search', placeholder: searchLabel, 'aria-label': searchLabel,
      oninput: (e) => { keyword = e.target.value.trim().toLowerCase(); applyFilter() }
    })
    const newBtn = el('button', {
      class: 'btn primary write',
      title: capTitle(caps, 'topicCrud', ''),
      onclick: () => openCreate()
    }, '⊕ 新建')
    const refreshBtn = el('button', { class: 'btn ghost', title: '刷新', onclick: () => load() }, '⟳')
    const count = el('span', { class: 'count' })
    const gridHost = el('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' })
    const toolbar = el('div', { class: 'toolbar' })

    let seg = null
    if (isRmq) {
      seg = el('div', { class: 'seg' }, ['queues', 'exchanges', 'bindings'].map((s) => el('button', {
        class: s === segment ? 'on' : '',
        onclick: (e) => {
          segment = s
          e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('on'))
          e.currentTarget.classList.add('on')
          syncToolbar()
          buildGrid()
          load()
        }
      }, { queues: '队列', exchanges: '交换机', bindings: '绑定' }[s])))
    }

    function syncToolbar() {
      toolbar.innerHTML = ''
      toolbar.appendChild(el('div', { class: 'search' }, ['🔍', search]))
      if (seg) toolbar.appendChild(seg)
      if (showCreate()) toolbar.appendChild(newBtn)
      toolbar.appendChild(refreshBtn)
      toolbar.appendChild(count)
    }
    function showCreate() {
      if (isMqtt) return false
      if (isRmq && segment === 'bindings') return false // 绑定删除走行右键，不提供新建
      return true
    }

    root.append(toolbar, loading, gridHost)
    syncToolbar()
    if (!crud().enabled) {
      newBtn.disabled = true
      newBtn.title = crud().reason
    }

    let grid = null
    function rebuildGrid(columns, emptyText, { onRowCtx } = {}) {
      grid = simpleGrid({
        columns,
        rowKey: (r) => r.__key ?? r.name ?? JSON.stringify(r),
        onRowCtx,
        emptyText
      })
      gridHost.innerHTML = ''
      gridHost.appendChild(grid.root)
      applyFilter()
    }

    /* —— 各 kind/segment 的列定义（pageColumns 描述符驱动；缺声明回落老逻辑兜底） —— */
    function buildGrid() {
      const segmentKey = isMqtt ? 'subscriptions'
        : isRmq ? (segment === 'topics' ? 'queues' : segment)
        : 'topics'
      const spec = pageColumnsOf(kind, segmentKey)
      if (spec && spec.length) {
        rebuildGrid(columnsFromSpec(spec), specEmptyText(), { onRowCtx: rowCtxOf() })
        return
      }
      // 兜底（描述符未就绪）：两列通用表
      rebuildGrid([
        { key: 'name', title: '名称', mono: true, width: '40%' },
        { key: 'messageCount', title: '消息数', num: true, render: (r) => fmt.compact(r.messageCount) }
      ], specEmptyText(), { onRowCtx: rowCtxOf() })
    }

    function specEmptyText() {
      if (isMqtt) return '暂无订阅关系'
      if (isRmq) return ({ queues: '暂无队列', exchanges: '暂无交换机', bindings: '暂无绑定' }[segment] ?? '暂无数据')
      return '暂无 Topic'
    }

    /** 当前分段对应的右键菜单 */
    function rowCtxOf() {
      if (isMqtt) return undefined
      if (isRmq && segment === 'exchanges') return rmqExchangeCtx
      if (isRmq && segment === 'bindings') return rmqBindingCtx
      if (isRmq) return rmqQueueCtx
      return topicCtx
    }

    function bindField(row, field) {
      return row[field] ?? row.extras?.[field] ?? '—'
    }

    /* —— 数据加载 —— */
    async function load() {
      if (loading.parentNode !== root) root.insertBefore(loading, gridHost)
      try {
        let rows = []
        if (isMqtt) {
          const res = await api.mw('topics.list', { sessionKey: ctx.sessionKey })
          rows = (Array.isArray(res) ? res : res?.items ?? res?.topics ?? [])
            .filter((r) => r.entity === 'subscription')
        } else if (isRmq && segment === 'exchanges') {
          const res = await api.mw('exchanges.list', { sessionKey: ctx.sessionKey })
          rows = Array.isArray(res) ? res : res?.items ?? []
        } else if (isRmq && segment === 'bindings') {
          const res = await api.mw('bindings.list', { sessionKey: ctx.sessionKey })
          rows = (Array.isArray(res) ? res : res?.items ?? []).map((r, i) => ({ __key: `b${i}`, ...r }))
        } else {
          const res = await api.mw('topics.list', { sessionKey: ctx.sessionKey })
          rows = (Array.isArray(res) ? res : res?.items ?? res?.topics ?? [])
            .filter((r) => !r.entity || r.entity === 'topic' || r.entity === 'queue')
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

    function applyFilter() {
      const rows = keyword
        ? allRows.filter((r) => String(r.name ?? bindField(r, 'source') ?? '').toLowerCase().includes(keyword)
          || String(bindField(r, 'routingKey') ?? '').toLowerCase().includes(keyword))
        : allRows
      grid?.update(rows, keyword && allRows.length ? '没有符合筛选条件的结果' : undefined)
      const unit = isMqtt ? '条订阅' : isRmq ? ({ queues: '个队列', exchanges: '个交换机', bindings: '条绑定' }[segment] ?? '项') : '个 Topic'
      count.innerHTML = `共 <b>${fmt.num(rows.length)}</b> ${unit}${isRmq || isMqtt ? '' : ' · 右键行查看操作'}`
    }

    /* —— 右键菜单 —— */
    function menuItem(label, icon, opts = {}) {
      const g = crud()
      const wg = opts.danger || opts.write ? writeGuard() : { blocked: false }
      let disabled = false
      let reason = ''
      if (opts.write && !g.enabled) { disabled = true; reason = g.reason }
      if ((opts.danger || opts.write) && wg.blocked) { disabled = true; reason = wg.reason }
      if (opts.disabled) { disabled = true; reason = opts.reason ?? '不可用' }
      return { label, icon, danger: opts.danger, disabled, reason, onClick: opts.onClick }
    }

    function topicCtx(e, row) {
      showContextMenu(e.clientX, e.clientY, [
        menuItem('查看消息', '📄', { onClick: () => gotoMessages(row.name) }),
        menuItem('编辑配置…', '⚙', { write: true, onClick: () => editTopicConfigs(row) }),
        'hr',
        kind === 'kafka' ? menuItem('扩容分区…', '＋', { write: true, onClick: () => growPartitions(row) }) : null,
        menuItem('清空消息…', '🧹', { danger: true, onClick: () => purgeTopic(row) }),
        menuItem('删除 Topic…', '🗑', { danger: true, onClick: () => deleteTopic(row) })
      ].filter((x) => x !== null && x !== false))
    }

    function rmqQueueCtx(e, row) {
      const dlqGate = gate(caps, 'dlqTemplates')
      showContextMenu(e.clientX, e.clientY, [
        menuItem('查看消息', '📄', { onClick: () => gotoMessages(row.name) }),
        menuItem('编辑参数…', '⚙', { write: true, onClick: () => editRmqQueue(row) }),
        'hr',
        menuItem('配置死信…', '💀', {
          write: true,
          disabled: !dlqGate.enabled,
          reason: dlqGate.reason,
          onClick: () => openDlqTemplate(row)
        }),
        menuItem('延迟队列模板…', '⏱', {
          write: true,
          disabled: !dlqGate.enabled,
          reason: dlqGate.reason,
          onClick: () => openDelayTemplate()
        }),
        'hr',
        menuItem('清空消息…', '🧹', { danger: true, onClick: () => purgeTopic(row) }),
        menuItem('删除队列…', '🗑', { danger: true, onClick: () => deleteTopic(row) })
      ])
    }

    function rmqExchangeCtx(e, row) {
      showContextMenu(e.clientX, e.clientY, [
        menuItem('删除交换机…', '🗑', { danger: true, onClick: async () => {
          const wg = writeGuard()
          if (wg.blocked) return api.toast(wg.reason, 'warn')
          const ok = await confirmDanger({
            title: '删除交换机',
            message: `将删除交换机 <b>${escapeHtml(String(row.name))}</b>，其绑定关系一并失效，不可恢复。`,
            requireText: String(row.name),
            confirmLabel: '删除'
          })
          if (!ok) return
          try {
            await api.mw('exchange.delete', { sessionKey: ctx.sessionKey, name: row.name })
            api.toast('已删除交换机', 'success')
            load()
          } catch (err) { api.toast(err?.message || String(err), 'error') }
        } })
      ])
    }

    function rmqBindingCtx(e, row) {
      showContextMenu(e.clientX, e.clientY, [
        menuItem('删除绑定…', '🗑', { danger: true, onClick: async () => {
          const wg = writeGuard()
          if (wg.blocked) return api.toast(wg.reason, 'warn')
          const label = `${bindField(row, 'source')}→${bindField(row, 'destination')}`
          const ok = await confirmDanger({
            title: '删除绑定',
            message: `将删除绑定 <b>${escapeHtml(String(label))}</b>（routing key: ${escapeHtml(String(bindField(row, 'routingKey') ?? ''))}）。`,
            requireText: String(label),
            confirmLabel: '删除'
          })
          if (!ok) return
          try {
            await api.mw('binding.delete', {
              sessionKey: ctx.sessionKey,
              source: bindField(row, 'source'),
              destination: bindField(row, 'destination'),
              routingKey: bindField(row, 'routingKey'),
              propertiesKey: bindField(row, 'propertiesKey')
            })
            api.toast('已删除绑定', 'success')
            load()
          } catch (err) { api.toast(err?.message || String(err), 'error') }
        } })
      ])
    }

    async function gotoMessages(topic) {
      // 附着 topic 到会话，消息页 render 时读取
      try {
        await api.session.set('attachTopic', topic)
        await api.session.set('messages.topic', topic)
      } catch { /* 会话存储失败仍可跳转 */ }
      ctx.switchPage('messages')
    }

    /* —— 危险操作 —— */
    async function purgeTopic(row) {
      const wg = writeGuard()
      if (wg.blocked) return api.toast(wg.reason, 'warn')
      const ok = await confirmDanger({
        title: '清空消息',
        message: `将清空 <b>${escapeHtml(String(row.name))}</b> 的全部消息，消息一旦清空不可恢复。`,
        requireText: String(row.name),
        confirmLabel: '清空'
      })
      if (!ok) return
      try {
        await api.mw('topic.purge', { sessionKey: ctx.sessionKey, name: row.name })
        api.toast('已提交清空', 'success')
        load()
      } catch (err) { api.toast(err?.message || String(err), 'error') }
    }

    async function deleteTopic(row) {
      const wg = writeGuard()
      if (wg.blocked) return api.toast(wg.reason, 'warn')
      const ok = await confirmDanger({
        title: isRmq ? '删除队列' : '删除 Topic',
        message: `将删除 <b>${escapeHtml(String(row.name))}</b> 及其全部数据，不可恢复。`,
        requireText: String(row.name),
        confirmLabel: '删除'
      })
      if (!ok) return
      try {
        await api.mw('topic.delete', { sessionKey: ctx.sessionKey, name: row.name })
        api.toast('已删除', 'success')
        load()
      } catch (err) { api.toast(err?.message || String(err), 'error') }
    }

    /* —— 扩容分区（kafka）—— */
    function growPartitions(row) {
      const cur = Number(row.partitions) || 0
      const input = numInput(cur + 1, { min: String(cur + 1), step: '1', style: 'width:100%' })
      const dlg = infoDialog({ title: `扩容分区 · ${row.name}`, width: 420 })
      dlg.body.appendChild(fieldRow(`目标分区数（当前 ${cur}，只增不减）`, input, 'Kafka 分区只能增加，不能减少'))
      dialogButtons(dlg, {
        submitLabel: '扩容',
        onSubmit: async () => {
          const target = Number(input.value)
          if (!Number.isInteger(target) || target <= cur) { input.focus(); return }
          try {
            await api.mw('partitions.grow', { sessionKey: ctx.sessionKey, name: row.name, partitions: target })
            api.toast(`分区已扩至 ${target}`, 'success')
            dlg.close()
            load()
          } catch (err) { api.toast(err?.message || String(err), 'error') }
        }
      })
      setTimeout(() => input.focus(), 30)
    }

    /* —— 编辑配置 —— */
    async function editTopicConfigs(row) {
      if (kind === 'rabbitmq') return editRmqQueue(row)
      try {
        const res = await api.mw('configs.describe', { sessionKey: ctx.sessionKey, name: row.name })
        const raw = res?.configs ?? res?.entries ?? res?.config ?? res
        let entries = []
        if (Array.isArray(raw)) entries = raw.map((c) => [c.name ?? c.key, c.value])
        else if (raw && typeof raw === 'object') entries = Object.entries(raw)
        const dlg = infoDialog({ title: `编辑配置 · ${row.name}`, width: 560 })
        if (!entries.length) {
          dlg.body.appendChild(el('p', { style: 'font-size:calc(var(--font-size-base, 13px) * 0.961538);color:var(--text-3)' }, '该 Topic 未返回可编辑配置'))
        }
        const inputs = {}
        for (const [key, value] of entries) {
          const input = textInput({ value: String(value ?? ''), 'data-cfg-key': String(key) })
          inputs[key] = { input, origin: String(value ?? '') }
          dlg.body.appendChild(fieldRow(String(key), input))
        }
        dialogButtons(dlg, {
          submitLabel: '保存变更',
          onSubmit: async () => {
            const changed = {}
            for (const [key, { input, origin }] of Object.entries(inputs)) {
              if (input.value !== origin) changed[key] = input.value
            }
            if (!Object.keys(changed).length) { dlg.close(); return }
            try {
              await api.mw('configs.alter', { sessionKey: ctx.sessionKey, name: row.name, configs: changed })
              api.toast('配置已保存', 'success')
              dlg.close()
            } catch (err) { api.toast(err?.message || String(err), 'error') }
          }
        })
      } catch (err) { api.toast(err?.message || String(err), 'error') }
    }

    function editRmqQueue(row) {
      const dlg = infoDialog({ title: `编辑队列参数 · ${row.name}`, width: 460 })
      const autoDelete = switchRow('<b>autoDelete</b>：最后一个消费者断开后自动删除', !!row.autoDelete)
      dlg.body.appendChild(el('div', { class: 'form-note' }, [
        el('span', {}, '⚠️'),
        el('span', { html: `durable 在队列创建后不可变更（当前：<b>${row.durable ? '持久' : '易失'}</b>）。` })
      ]))
      dlg.body.appendChild(autoDelete.row)
      const argsInput = el('textarea', {
        rows: '4', spellcheck: 'false',
        placeholder: '{}'
      })
      try { argsInput.value = JSON.stringify(row.extras?.arguments ?? row.arguments ?? {}, null, 2) } catch { argsInput.value = '{}' }
      dlg.body.appendChild(fieldRow('arguments（JSON）', argsInput, 'x-arguments：如 {"x-message-ttl":60000}'))
      dialogButtons(dlg, {
        submitLabel: '保存',
        onSubmit: async () => {
          let arguments_
          try { arguments_ = argsInput.value.trim() ? JSON.parse(argsInput.value) : {} } catch { return api.toast('arguments 不是合法 JSON', 'error') }
          try {
            await api.mw('topic.update', {
              sessionKey: ctx.sessionKey, name: row.name,
              autoDelete: autoDelete.get(), arguments: arguments_
            })
            api.toast('队列参数已保存', 'success')
            dlg.close()
            load()
          } catch (err) { api.toast(err?.message || String(err), 'error') }
        }
      })
    }

    /* —— 新建 —— */
    function openCreate() {
      const g = crud()
      if (!g.enabled) return api.toast(g.reason, 'warn')
      const wg = writeGuard()
      if (wg.blocked) return api.toast(wg.reason, 'warn')
      if (isRmq && segment === 'exchanges') return createExchange()
      if (isRmq) return createQueue()
      if (kind === 'kafka') return createKafkaTopic()
      if (kind === 'rocketmq') return createRocketTopic()
    }

    function createKafkaTopic() {
      const dlg = infoDialog({ title: '新建 Topic', width: 480 })
      const name = textInput({ placeholder: '如 order-events' })
      const partitions = numInput(3, { min: '1', step: '1' })
      const replicas = numInput(1, { min: '1', step: '1' })
      const configs = el('textarea', { rows: '3', spellcheck: 'false', placeholder: '{\n  "max.message.bytes": 1048576\n}' })
      dlg.body.appendChild(fieldRow('名称', name))
      dlg.body.appendChild(el('div', { class: 'form-cols' }, [
        fieldRow('分区数', partitions),
        fieldRow('副本因子', replicas)
      ]))
      dlg.body.appendChild(fieldRow('初始配置（可选，JSON）', configs))
      dialogButtons(dlg, {
        submitLabel: '创建',
        onSubmit: async () => {
          if (!name.value.trim()) { name.focus(); return }
          let cfg = {}
          if (configs.value.trim()) {
            try { cfg = JSON.parse(configs.value) } catch { return api.toast('配置不是合法 JSON', 'error') }
          }
          try {
            await api.mw('topic.create', {
              sessionKey: ctx.sessionKey, name: name.value.trim(),
              partitions: Number(partitions.value) || 1,
              replicationFactor: Number(replicas.value) || 1,
              configs: cfg
            })
            api.toast('Topic 已创建', 'success')
            dlg.close()
            load()
          } catch (err) { api.toast(err?.message || String(err), 'error') }
        }
      })
      setTimeout(() => name.focus(), 30)
    }

    function createRocketTopic() {
      const dlg = infoDialog({ title: '新建 Topic', width: 460 })
      const name = textInput({ placeholder: '如 order-events' })
      const queueNum = numInput(8, { min: '1', step: '1' })
      const type = el('select', {}, ['normal', 'fifo', 'delay', 'transaction'].map((t) => el('option', { value: t }, t)))
      dlg.body.appendChild(fieldRow('名称', name))
      dlg.body.appendChild(el('div', { class: 'form-cols' }, [
        fieldRow('队列数（queueNum）', queueNum),
        fieldRow('类型', type)
      ]))
      dialogButtons(dlg, {
        submitLabel: '创建',
        onSubmit: async () => {
          if (!name.value.trim()) { name.focus(); return }
          try {
            await api.mw('topic.create', {
              sessionKey: ctx.sessionKey, name: name.value.trim(),
              queueNum: Number(queueNum.value) || 8,
              type: type.value
            })
            api.toast('Topic 已创建', 'success')
            dlg.close()
            load()
          } catch (err) { api.toast(err?.message || String(err), 'error') }
        }
      })
      setTimeout(() => name.focus(), 30)
    }

    function createQueue() {
      const dlg = infoDialog({ title: '新建队列', width: 460 })
      const name = textInput({ placeholder: '如 order.queue' })
      const durable = switchRow('<b>durable</b> 持久化', true)
      const autoDelete = switchRow('<b>autoDelete</b> 自动删除', false)
      const args = el('textarea', { rows: '3', spellcheck: 'false', placeholder: '{\n  "x-message-ttl": 60000\n}' })
      dlg.body.appendChild(fieldRow('名称', name))
      dlg.body.appendChild(durable.row)
      dlg.body.appendChild(autoDelete.row)
      dlg.body.appendChild(fieldRow('arguments（可选，JSON）', args))
      dialogButtons(dlg, {
        submitLabel: '创建',
        onSubmit: async () => {
          if (!name.value.trim()) { name.focus(); return }
          let arguments_
          try { arguments_ = args.value.trim() ? JSON.parse(args.value) : {} } catch { return api.toast('arguments 不是合法 JSON', 'error') }
          try {
            await api.mw('topic.create', {
              sessionKey: ctx.sessionKey, name: name.value.trim(),
              durable: durable.get(), autoDelete: autoDelete.get(), arguments: arguments_
            })
            api.toast('队列已创建', 'success')
            dlg.close()
            load()
          } catch (err) { api.toast(err?.message || String(err), 'error') }
        }
      })
      setTimeout(() => name.focus(), 30)
    }

    function createExchange() {
      const dlg = infoDialog({ title: '新建交换机', width: 460 })
      const name = textInput({ placeholder: '如 order.exchange' })
      const type = el('select', {}, ['direct', 'topic', 'fanout', 'headers'].map((t) => el('option', { value: t }, t)))
      const durable = switchRow('<b>durable</b> 持久化', true)
      const autoDelete = switchRow('<b>autoDelete</b> 自动删除', false)
      dlg.body.appendChild(fieldRow('名称', name))
      dlg.body.appendChild(fieldRow('类型', type))
      dlg.body.appendChild(durable.row)
      dlg.body.appendChild(autoDelete.row)
      dialogButtons(dlg, {
        submitLabel: '创建',
        onSubmit: async () => {
          if (!name.value.trim()) { name.focus(); return }
          try {
            await api.mw('exchange.create', {
              sessionKey: ctx.sessionKey, name: name.value.trim(),
              type: type.value, durable: durable.get(), autoDelete: autoDelete.get()
            })
            api.toast('交换机已创建', 'success')
            dlg.close()
            load()
          } catch (err) { api.toast(err?.message || String(err), 'error') }
        }
      })
      setTimeout(() => name.focus(), 30)
    }

    /* —— mqtt：无 topic 管理，降级说明 + 订阅关系 —— */
    if (isMqtt) {
      const g = crud()
      const note = el('div', { class: 'form-note', style: 'margin:12px 16px 0' }, [
        el('span', {}, g.enabled ? 'ℹ️' : '⚠️'),
        el('span', { html: g.enabled
          ? '通用 MQTT 无 Topic 实体与历史消息管理，本页仅展示 <b>EMQX 订阅关系</b>。'
          : `MQTT 无 Topic 管理${g.reason ? `（${escapeHtml(g.reason)}）` : ''}；仅支持 pub/sub 与 retained 快照。` })
      ])
      const retainedNote = el('div', { class: 'form-note', style: 'margin:8px 16px 0' }, [
        el('span', {}, '💡'),
        el('span', { html: 'Retained 保留消息请前往 <b>消息</b> 页查看与清理。' })
      ])
      root.insertBefore(el('div', { style: 'flex:none' }, [note, retainedNote]), gridHost)
    }

    /* —— RabbitMQ 死信/延迟模板 —— */
    async function openDlqTemplate(row) {
      const wg = writeGuard()
      if (wg.blocked) return api.toast(wg.reason, 'warn')
      const dlg = infoDialog({ title: `配置死信 · ${row.name}`, width: 480 })
      const exchange = textInput({ value: `${row.name}.dlx`, placeholder: '死信交换机' })
      const dlq = textInput({ value: `${row.name}.dlq`, placeholder: '死信队列' })
      const routingKey = textInput({ value: row.name, placeholder: '缺省用源队列名' })
      dlg.body.appendChild(fieldRow('死信交换机（direct）', exchange))
      dlg.body.appendChild(fieldRow('死信队列', dlq))
      dlg.body.appendChild(fieldRow('Routing Key', routingKey))
      dlg.body.appendChild(el('div', { class: 'form-note', style: 'margin-top:10px' }, [
        el('span', {}, 'ℹ️'),
        el('span', { html: '将创建交换机+队列+绑定，并回写源队列的 <b>x-dead-letter-exchange</b> 参数（既有 arguments 保留）。' })
      ]))
      dialogButtons(dlg, {
        submitLabel: '一键配置',
        onSubmit: async () => {
          if (!exchange.value.trim() || !dlq.value.trim()) { exchange.focus(); return }
          try {
            const res = await api.mw('queue.template', {
              sessionKey: ctx.sessionKey, template: 'dlq', queue: row.name,
              exchange: exchange.value.trim(), dlq: dlq.value.trim(), routingKey: routingKey.value.trim()
            })
            api.toast(`已配置死信（${res?.created?.length ?? 0} 项变更）`, 'success')
            dlg.close()
            load()
          } catch (err) { api.toast(err?.message || String(err), 'error') }
        }
      })
      setTimeout(() => exchange.focus(), 30)
    }

    async function openDelayTemplate() {
      const wg = writeGuard()
      if (wg.blocked) return api.toast(wg.reason, 'warn')
      const delayGate = gate(caps, 'delayQueue')
      const dlg = infoDialog({ title: '延迟队列模板', width: 520 })
      const queue = textInput({ placeholder: '目标队列名（如 order.delay.queue）' })
      let route = 'ttl' // 'ttl' | 'plugin'
      const routeSeg = el('div', { class: 'seg' })
      const routeButtons = [
        { key: 'ttl', label: 'TTL + 死信' },
        { key: 'plugin', label: 'x-delayed-message 插件', disabled: !delayGate.enabled }
      ].map((r) => el('button', {
        class: r.key === 'ttl' ? 'on' : '',
        disabled: r.disabled ? '' : undefined,
        title: r.disabled ? delayGate.reason : undefined,
        onclick: (e) => {
          route = r.key
          e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('on'))
          e.currentTarget.classList.add('on')
          ttlRow.style.display = r.key === 'ttl' ? '' : 'none'
        }
      }, r.label))
      routeSeg.append(...routeButtons)
      dlg.body.appendChild(fieldRow('路线', routeSeg, delayGate.enabled ? '插件路线按消息 x-delay 头延迟；TTL 路线队列级固定延迟' : `插件未安装（${delayGate.reason ?? ''}），仅 TTL 路线可用`))
      dlg.body.appendChild(fieldRow('目标队列', queue))
      const ttl = numInput(60000, { min: '1', step: '1000', style: 'width:100%' })
      const ttlRow = fieldRow('延迟毫秒（TTL 路线）', ttl, '消息在缓冲队列滞留该时长后转入目标队列')
      dlg.body.appendChild(ttlRow)
      dialogButtons(dlg, {
        submitLabel: '创建',
        onSubmit: async () => {
          if (!queue.value.trim()) { queue.focus(); return }
          if (route === 'ttl' && !(Number(ttl.value) > 0)) { ttl.focus(); return }
          try {
            const res = await api.mw('queue.template', {
              sessionKey: ctx.sessionKey,
              template: 'delay',
              queue: queue.value.trim(),
              ttlMs: Number(ttl.value) || 60000,
              usePlugin: route === 'plugin'
            })
            api.toast(`延迟队列已创建（${res?.created?.length ?? 0} 项）`, 'success')
            dlg.close()
            load()
          } catch (err) { api.toast(err?.message || String(err), 'error') }
        }
      })
      setTimeout(() => queue.focus(), 30)
    }

    buildGrid()
    load()
  },
  destroy() { /* 无定时器/监听 */ }
}
