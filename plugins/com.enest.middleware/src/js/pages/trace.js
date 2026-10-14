/** RocketMQ 消息轨迹：按 Key / MsgId 查询链路，produced → stored → consume-attempt*n 时间线 */
import { el, fmt, gate, escapeHtml } from '../components.js'

const PHASE_LABEL = { produced: '生产', stored: '存储', 'consume-attempt': '消费尝试' }
const STATUS_LABEL = { ok: '成功', success: '成功', failed: '失败', error: '失败', retry: '重试中', timeout: '超时' }
function statusChip(status) {
  const s = String(status ?? '').toLowerCase()
  const failed = s === 'failed' || s === 'error' || s === 'timeout'
  const warn = s === 'retry'
  const label = STATUS_LABEL[s] ?? (status || '未知')
  return `<span class="chip ${failed ? 'bad' : warn ? 'warn' : 'ok'}"><span class="dot"></span>${escapeHtml(label)}</span>`
}
function kvChips(detail) {
  const items = Object.entries(detail ?? {})
  if (!items.length) return ''
  return items.map(([k, v]) => {
    const text = v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return `<span class="chip">${escapeHtml(k)}=${escapeHtml(text.length > 60 ? text.slice(0, 60) + '…' : text)}</span>`
  }).join('')
}

export default {
  id: 'trace',

  render(root, ctx) {
    const { api } = ctx

    /* —— 检索条：Key / MsgId 二选一 —— */
    let mode = 'key' // 'key' | 'id'
    const input = el('input', {
      type: 'text', placeholder: '输入消息 Key', style: 'width:280px', autocomplete: 'off',
      onkeydown: (e) => { if (e.key === 'Enter') doQuery() }
    })
    const seg = el('div', { class: 'seg' }, [
      el('button', { class: 'on', onclick: (e) => setMode('key', e.currentTarget) }, '按 Key'),
      el('button', { onclick: (e) => setMode('id', e.currentTarget) }, '按 MsgId')
    ])
    function setMode(m, btn) {
      mode = m
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn))
      input.placeholder = m === 'key' ? '输入消息 Key' : '输入 MsgId'
      input.focus()
    }
    const queryBtn = el('button', { class: 'btn primary', onclick: doQuery }, '查询')
    const loading = el('div', { class: 'loading-bar', style: 'display:none;position:absolute;left:0;right:0;top:0' })

    const search = el('div', { class: 'trace-search', style: 'position:relative' }, [seg, input, queryBtn])
    const wrap = el('div', { class: 'trace-wrap' })

    root.style.position = 'relative'
    root.append(search, loading, wrap)
    renderEmpty('输入消息 Key 查询链路（需 broker 开启 trace）')

    /* —— caps gate：trace 能力降级 —— */
    const g = gate(ctx.caps, 'trace')
    if (!g.enabled) {
      queryBtn.disabled = true
      input.disabled = true
      renderEmpty(`消息轨迹不可用：${g.reason}`)
    }

    /* —— 查询与渲染 —— */
    async function doQuery() {
      const value = input.value.trim()
      if (!value) { api.toast(mode === 'key' ? '请输入消息 Key' : '请输入 MsgId', 'warn'); return }
      loading.style.display = ''
      try {
        const inputBody = mode === 'key' ? { key: value } : { messageId: value }
        const res = await api.mw('trace.message', inputBody)
        const trace = Array.isArray(res) ? res[0] : res
        renderTrace(trace)
      } catch (e) {
        api.toast(e.message, 'error')
        renderEmpty('查询失败，请稍后重试')
      } finally {
        loading.style.display = 'none'
      }
    }

    function renderEmpty(text) {
      wrap.innerHTML = ''
      wrap.appendChild(el('div', { class: 'empty-cap' }, [
        el('div', { class: 'big' }, '⌖'),
        text
      ]))
    }

    function renderTrace(trace) {
      wrap.innerHTML = ''
      const steps = Array.isArray(trace?.steps) ? trace.steps : []
      if (!steps.length) { renderEmpty('未查到轨迹（消息 Key 不存在，或 broker 未开启 trace）'); return }

      // 头部摘要：key / messageId
      wrap.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px' }, [
        el('span', { style: 'font-size:12.5px;font-weight:600' }, '消息链路'),
        trace?.key ? el('span', { style: 'font-family:var(--mono);font-size:11.5px;color:var(--text-2)' }, `Key: ${trace.key}`) : null,
        trace?.messageId ? el('span', { class: 'chip', title: trace.messageId }, shortId(trace.messageId)) : null,
        el('span', { style: 'flex:1' }),
        el('span', { style: 'color:var(--text-3);font-size:11.5px' }, `共 ${steps.length} 步`)
      ]))

      const timeline = el('div', { class: 'trace-timeline' })
      for (const step of steps) {
        const status = String(step.status ?? '').toLowerCase()
        const stateCls = status === 'failed' || status === 'error' || status === 'timeout' ? 'failed' : 'ok'
        timeline.appendChild(el('div', { class: `trace-step ${stateCls}` }, [
          el('div', { class: 'rail' }, [el('div', { class: 'pt' }), el('div', { class: 'ln' })]),
          el('div', { class: 'card' }, [
            el('div', { class: 't1' }, [
              el('span', { class: 'trace-phase' }, PHASE_LABEL[step.phase] ?? step.phase ?? '未知阶段'),
              el('span', {}, step.actor || ''),
              el('span', { html: statusChip(step.status) }),
              el('span', { class: 'when' }, fmt.datetimeMs(step.timestamp))
            ]),            ...(step.costMs != null ? [el('div', { style: 'margin-top:5px;font-size:11.5px;color:var(--text-3)' }, `耗时 ${fmt.ms(step.costMs)}`)] : []),
            ...(Object.keys(step.detail ?? {}).length ? [el('div', { class: 'kv', html: kvChips(step.detail) })] : [])
          ])
        ]))
      }
      wrap.appendChild(timeline)
    }

    function shortId(id) {
      const s = String(id ?? '')
      return s.length > 26 ? s.slice(0, 26) + '…' : s
    }
  },

  destroy() { /* 无定时器/订阅 */ }
}
