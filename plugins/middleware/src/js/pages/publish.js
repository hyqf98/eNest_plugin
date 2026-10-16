/** 发消息工具：按 kind 自适应字段，payload 可格式化预览，Mod+Enter 快捷发送 */
import { el, payloadHighlight } from '@mw/components.js'
import { attachJsonEditor, attachSuggestions } from '@mw/editorAssist.js'
import { commands, displayShortcut } from '@mw/commands.js'
import { namedSuggestions } from '@mw/completionRules.js'

const TOPIC_LABEL = { kafka: 'Topic', rabbitmq: '队列', mqtt: 'Topic', rocketmq: 'Topic' }

export default {
  id: 'publish',

  render(root, ctx) {
    const { api, conn } = ctx
    const kind = conn.kind
    const getPreferences = () => ctx.store.ui.productivity.completion

    /* —— Topic（datalist 下拉候选 + 手输）—— */
    let topicNames = []
    const assistants = []
    let sending = false
    const topicIn = el('input', { type: 'text', 'aria-label': '发布目标', placeholder: '如 order-events', autocomplete: 'off' })
    const keyIn = el('input', { type: 'text', placeholder: '分区按 key 哈希', autocomplete: 'off' })
    const partIn = el('input', { type: 'number', placeholder: '缺省自动', min: '0' })
    const rkIn = el('input', { type: 'text', placeholder: '默认交换机按队列名路由', autocomplete: 'off' })
    const qosSel = el('select', {}, [0, 1, 2].map((q) => el('option', { value: String(q) }, `QoS ${q}`)))
    const retainSwitch = el('button', { class: 'switch', role: 'switch', onclick: () => retainSwitch.classList.toggle('on') })

    /* —— headers KV 行编辑器 —— */
    const kvBody = el('div', { style: 'display:flex;flex-direction:column;gap:6px' })
    function addKvRow(k = '', v = '') {
      const ki = el('input', { type: 'text', placeholder: 'header 名', autocomplete: 'off', value: k, style: 'flex:1' })
      const vi = el('input', { type: 'text', placeholder: '值', autocomplete: 'off', value: v, style: 'flex:1' })
      const row = el('div', { style: 'display:flex;gap:6px' }, [
        ki, vi,
        el('button', {
          class: 'btn ghost sm', title: '删除此行',
          onclick: () => row.remove()
        }, '✕')
      ])
      kvBody.appendChild(row)
      assistants.push(attachSuggestions(ki, { label: 'Header 名称建议', isActive: ctx.isActive, getPreferences, getItems: (value, caret) => namedSuggestions(value, caret, { kind: 'header', names: ['content-type', 'correlation-id', 'traceparent', 'message-id'], connection: conn, preferences: getPreferences() }) }))
    }
    addKvRow()

    /* —— payload：编辑 / 预览双态 —— */
    const payloadIn = el('textarea', {
      class: 'payload-editor', 'aria-label': '消息内容', spellcheck: 'false'
    })
    const payloadPreview = el('div', { class: 'payload-pane', style: 'display:none;border:1px solid var(--border);border-radius:var(--radius-sm);height:80%;min-height:220px' })
    const editorStatus = el('div', { class: 'editor-status', role: 'status' })
    const jsonEditor = attachJsonEditor(payloadIn, editorStatus, { getPreferences, connection: conn, isActive: ctx.isActive })
    assistants.push(jsonEditor)
    const jsonFormatBtn = el('button', { class: 'btn sm', title: displayShortcut(commands.shortcut('mw.formatJson')), onclick: () => jsonEditor.format() }, '格式化')
    let previewing = false
    const formatBtn = el('button', {
      class: 'btn',
      onclick: () => {
        // 切换预览态：先尝试格式化回填，非法 JSON 时给出预览（原文着色）
        const raw = payloadIn.value
        if (!previewing) {
          let text = raw
          try { text = JSON.stringify(JSON.parse(raw), null, 2) } catch { /* 纯文本原样预览 */ }
          payloadPreview.innerHTML = payloadHighlight(text) || '<span style="color:var(--text-3)">（空）</span>'
          payloadIn.style.display = 'none'
          payloadPreview.style.display = ''
          formatBtn.textContent = '✎ 继续编辑'
          previewing = true
        } else {
          payloadIn.style.display = ''
          payloadPreview.style.display = 'none'
          formatBtn.textContent = '预览'
          previewing = false
        }
      }
    }, '预览')

    /* —— kind 自适应字段组 —— */
    const form = el('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column;padding:14px 18px;overflow:auto' }, [
      el('div', { class: 'form-cols' }, [
        el('div', { class: 'form-row' }, [
          el('label', {}, [TOPIC_LABEL[kind] + ' ', el('span', { style: 'color:var(--accent)' }, '*')]), topicIn
        ]),
        ...(kind === 'kafka' ? [
          el('div', { class: 'form-row' }, [el('label', {}, 'Key（可选）'), keyIn])
        ] : [])
      ]),
      kind === 'kafka' ? el('div', { class: 'form-cols' }, [
        el('div', { class: 'form-row' }, [el('label', {}, '分区（可选）'), partIn])
      ]) : null,
      kind === 'rabbitmq' ? el('div', { class: 'form-cols' }, [
        el('div', { class: 'form-row' }, [el('label', {}, 'Routing Key（可选）'), rkIn])
      ]) : null,
      kind === 'mqtt' ? el('div', { class: 'form-cols' }, [
        el('div', { class: 'form-row' }, [el('label', {}, 'QoS'), qosSel]),
        el('div', { class: 'form-row' }, [
          el('label', {}, 'Retained'),
          el('div', { class: 'switch-row', style: 'padding-top:2px' }, [retainSwitch, el('span', { class: 'sl' }, '保留消息（新订阅者立即收到）')])
        ])
      ]) : null,
      kind === 'mqtt' ? el('div', { class: 'editor-status' }, '当前 MQTT 驱动支持 Topic、QoS 与 Retained，不转发自定义发布属性。') : el('div', { class: 'form-row', style: 'margin-bottom:8px' }, [
        el('label', {}, 'Headers'),
        kvBody,
        el('button', { class: 'btn ghost sm', style: 'margin-top:6px', onclick: () => addKvRow() }, '＋ 添加一项')
      ]),
      el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px;flex:none' }, [
        el('label', { style: 'font-size:calc(var(--font-size-base, 13px) * 0.923077);color:var(--text-2)' }, 'Payload'),
        el('span', { style: 'flex:1' }),
        jsonFormatBtn, formatBtn
      ]),
      payloadIn,
      payloadPreview, editorStatus
    ])

    const sendBtn = el('button', { class: 'btn primary write', onclick: doSend }, '发送消息')
    const hint = el('span', { class: 'publish-status', role: 'status' }, `${displayShortcut(commands.shortcut('mw.send'))} 发送 · Enter 换行 · 发送后保留表单`)
    const foot = el('div', { class: 'toolbar', style: 'flex-wrap:nowrap;align-items:center;border-top:1px solid var(--border);padding:10px 18px' }, [
      hint,
      el('span', { style: 'flex:1' }),
      sendBtn
    ])

    root.append(form, foot)
    assistants.push(attachSuggestions(topicIn, { label: '发布目标建议', isActive: ctx.isActive, getPreferences, getItems: (value, caret) => namedSuggestions(value, caret, { names: topicNames, connection: conn, preferences: getPreferences() }) }))
    if (ctx.mode === 'quick') hint.textContent = 'quick 只读模式：发送已禁用'

    /* —— Topic 候选懒加载 —— */
    api.mw('topics.list', {}).then((res) => {
      const list = Array.isArray(res) ? res : (res?.topics ?? res?.items ?? [])
      for (const t of list) {
        const name = typeof t === 'string' ? t : t?.name
        if (name) topicNames.push(name)
      }
    }).catch(() => { /* 候选缺失不阻塞手输 */ })

    /* —— 发送 —— */
    function collectHeaders() {
      const headers = {}
      for (const row of kvBody.children) {
        const inputs = row.querySelectorAll('input')
        if (inputs.length < 2) continue
        const k = inputs[0].value.trim(), v = inputs[1].value
        if (k) headers[k] = v
      }
      return Object.keys(headers).length ? headers : undefined
    }
    async function doSend() {
      if (sending || !ctx.isActive()) return
      if (conn.readOnly || ctx.mode === 'quick') { api.toast('只读连接（或 quick 模式）禁止发送', 'error'); return }
      if (previewing) formatBtn.click() // 回到编辑态，确保 payloadIn 最新
      const topic = topicIn.value.trim()
      if (!topic) { api.toast(`请填写 ${TOPIC_LABEL[kind]}`, 'warn'); topicIn.focus(); return }
      const input = { topic, payload: payloadIn.value, ...(kind !== 'mqtt' ? { headers: collectHeaders() } : {}) }
      if (kind === 'kafka') {
        if (keyIn.value.trim()) input.key = keyIn.value.trim()
        if (partIn.value !== '') input.partition = Number(partIn.value)
      }
      if (kind === 'rabbitmq' && rkIn.value.trim()) input.routingKey = rkIn.value.trim()
      if (kind === 'mqtt') {
        input.qos = Number(qosSel.value) || 0
        input.retain = retainSwitch.classList.contains('on')
      }
      sending = true
      sendBtn.disabled = true
      hint.textContent = `正在发送到 ${topic}…`
      try {
        const res = await api.mw('messages.send', input)
        // RabbitMQ 管理面返回 routed 标志；routed=false 提示无人消费
        if (kind === 'rabbitmq' && res && (typeof res.routed === 'boolean' || typeof res.detail === 'string')) {
          const routed = res.routed ?? !res.detail.includes('未路由')
          api.toast(routed ? '已发送（已路由到队列）' : '已发送但未路由：无匹配队列/绑定', routed ? 'success' : 'warn')
        } else {
          api.toast('发送成功', 'success')
        }
        hint.textContent = kind === 'rabbitmq' && (res?.routed === false || res?.detail?.includes('未路由')) ? '已发送但未路由：无匹配队列或绑定' : `已发送到 ${topic} · 内容已保留`
        // 连发测试场景：成功后不清空表单
      } catch (e) {
        hint.textContent = `发送失败：${e.message}`
        hint.dataset.state = 'error'
      } finally {
        sending = false
        sendBtn.disabled = false
      }
    }

    const removeSend = commands.register('mw.send', { element: root, isActive: () => ctx.isActive() && !conn.readOnly && ctx.mode !== 'quick', run: doSend })
    const removePreview = commands.register('mw.preview', { element: root, isActive: ctx.isActive, run: () => formatBtn.click() })
    const updateShortcuts = () => {
      jsonFormatBtn.title = displayShortcut(commands.shortcut('mw.formatJson'))
      if (!sending) hint.textContent = ctx.mode === 'quick' ? 'quick 只读模式：发送已禁用' : `${displayShortcut(commands.shortcut('mw.send'))} 发送 · Enter 换行 · 发送后保留表单`
    }
    document.addEventListener('mw-productivity-changed', updateShortcuts)
    this.__unbind = () => { removeSend(); removePreview(); document.removeEventListener('mw-productivity-changed', updateShortcuts); assistants.forEach(assistant => assistant.destroy()) }
  },

  destroy() {
    this.__unbind?.()
  }
}
