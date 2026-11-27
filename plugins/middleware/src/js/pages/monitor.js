/** 监控页：30s 轮询 overview，指标卡从 metricsSpec 描述符渲染；采样存 api.session；quick 模式禁自动轮询 */
import { fmt, chip, el, emptyState, sparkline, escapeHtml, simpleGrid, fmtMetricValue } from '@mw/components.js'
import { metricsSpecOf } from '@mw/kinds.js'

const POLL_MS = 30_000
const MAX_SAMPLES = 12
/* 描述符未覆盖的动态键（EMQX $SYS）回落猜单位 */
const BYTES_KEYS = /(bytes|size|disk|storage)/i
const MS_KEYS = /(latency|duration|ms\b|time)/i

function labelOf(specEntry, key) {
  if (specEntry?.label) return specEntry.label
  const pretty = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return pretty.charAt(0).toUpperCase() + pretty.slice(1)
}
function fmtMetric(specMap, key, value) {
  const spec = specMap.get(key)
  if (spec) return fmtMetricValue(spec, value)
  // 兜底：动态键猜单位
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'string') return escapeHtml(value)
  const n = Number(value)
  if (!Number.isFinite(n)) return escapeHtml(String(value ?? '—'))
  if (BYTES_KEYS.test(key) && !/rate/i.test(key)) return fmt.bytes(n)
  if (MS_KEYS.test(key)) return fmt.ms(n)
  return fmt.compact(n)
}

/* 模块级实例清理句柄：路由 destroy() 时回调（清 interval） */

export default {
  id: 'monitor',
  render(root, ctx) {
    const { api, mode, conn } = ctx
    root.innerHTML = ''

    let timer = null
    let destroyed = false
    let autoOn = false // quick 模式默认关
    let series = {} // key → number[]（最近 MAX_SAMPLES 个采样）

    const loading = el('div', { class: 'loading-bar' })
    const statusText = el('span', { style: 'color:var(--text-3);font-size:calc(var(--font-size-base, 13px) * 0.884615)' }, '未开始采样')

    /* —— 自动刷新开关 + 手动刷新 —— */
    const autoSwitch = el('button', { class: `switch ${autoOn ? 'on' : ''}`, type: 'button', title: '每 30 秒自动采样一次' })
    const autoLabel = el('span', { class: 'sl', style: 'font-size:calc(var(--font-size-base, 13px) * 0.923077);color:var(--text-2)' }, '自动刷新')
    const autoWrap = el('div', { class: 'switch-row switch-row-flush' }, [autoSwitch, autoLabel])
    if (mode === 'quick') {
      autoSwitch.disabled = true
      autoSwitch.title = 'quick 模式禁用自动轮询，请手动刷新'
      autoLabel.appendChild(el('span', { style: 'color:var(--text-3);font-size:calc(var(--font-size-base, 13px) * 0.846154);margin-left:4px' }, '（quick 只读，手动）'))
    }
    autoSwitch.addEventListener('click', () => {
      if (mode === 'quick') return api.toast('quick 模式禁用自动轮询', 'warn')
      setAuto(!autoOn)
    })

    const toolbar = el('div', { class: 'toolbar' }, [
      autoWrap,
      el('button', { class: 'btn', onclick: () => sample(true) }, '⟳ 立即刷新'),
      el('span', { style: 'flex:1' }),
      statusText
    ])
    const body = el('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column;overflow-y:auto' })
    root.append(toolbar, loading, body)

    function setAuto(on) {
      if (destroyed) return
      autoOn = on
      autoSwitch.classList.toggle('on', on)
      if (timer) { clearInterval(timer); timer = null }
      if (on) {
        timer = setInterval(() => sample(false), POLL_MS)
        sample(false)
      }
      persist()
    }

    async function persist() {
      try { await api.session.set('monitor.auto', autoOn) } catch { /* 忽略 */ }
    }

    async function restore() {
      try {
        series = (await api.session.get('monitor.series')) ?? {}
        if (series && typeof series === 'object' && !Array.isArray(series)) {
          for (const k of Object.keys(series)) {
            if (!Array.isArray(series[k])) series[k] = []
          }
        } else series = {}
        const saved = await api.session.get('monitor.auto')
        if (destroyed) return
        if (saved === true && mode !== 'quick') setAuto(true)
        else renderData(null) // 先画空态
      } catch {
        series = {}
        renderData(null)
      }
    }

    async function sample(manual) {
      if (destroyed) return
      if (loading.parentNode !== root) root.insertBefore(loading, body)
      try {
        const ov = await api.mw('overview', { sessionKey: ctx.sessionKey })
        if (destroyed) return
        pushSample(ov)
        renderData(ov)
        if (manual) api.toast('已采样', 'success')
      } catch (err) {
        if (destroyed) return
        statusText.textContent = `采样失败：${err?.message || err}`
        if (!body.childElementCount) {
          body.innerHTML = ''
          body.appendChild(el('div', { class: 'empty-cap' }, [
            el('div', { class: 'big' }, '⚠️'),
            el('div', { style: 'margin-bottom:14px' }, `监控数据获取失败：${escapeHtml(err?.message || String(err))}`),
            el('button', { class: 'btn primary', onclick: () => sample(true) }, '重试')
          ]))
        } else api.toast(err?.message || String(err), 'error')
      } finally {
        loading.remove()
      }
    }

    function pushSample(ov) {
      const metrics = ov?.metrics && typeof ov.metrics === 'object' ? ov.metrics : {}
      const numeric = {}
      for (const [k, v] of Object.entries(metrics)) {
        const n = Number(v)
        if (Number.isFinite(n)) numeric[k] = n
      }
      const keys = new Set([...Object.keys(series), ...Object.keys(numeric)])
      for (const k of keys) {
        if (!Array.isArray(series[k])) series[k] = []
        if (numeric[k] !== undefined) {
          series[k].push(numeric[k])
          if (series[k].length > MAX_SAMPLES) series[k].shift()
        }
      }
      // 只保留最近 MAX_SAMPLES 个采样点（缺失轮次也截断）
      for (const k of Object.keys(series)) if (series[k].length > MAX_SAMPLES) series[k] = series[k].slice(-MAX_SAMPLES)
      try { api.session.set('monitor.series', series) } catch { /* 忽略 */ }
      const first = Object.keys(series)[0]
      statusText.textContent = `采样 ${first ? series[first].length : 0}/${MAX_SAMPLES} · 每 ${POLL_MS / 1000}s 一点${autoOn ? '' : ' · 自动刷新关'}`
    }

    function renderData(ov) {
      if (destroyed) return
      body.innerHTML = ''
      const metrics = ov?.metrics && typeof ov.metrics === 'object' ? ov.metrics : {}
      // 指标描述：运行时 metricSpecs 优先（EMQX 探测后），缺省用 kinds 描述符 metricsSpec
      const specList = ov?.metricSpecs?.length ? ov.metricSpecs : (metricsSpecOf(conn?.kind) ?? [])
      const specMap = new Map(specList.map(s => [s.key, s]))
      const entries = specList.length
        // 描述符有声明：按声明顺序渲染（未出现在 metrics 的跳过）
        ? specList.map(s => [s.key, metrics[s.key]]).filter(([, v]) => v !== undefined)
        : Object.entries(metrics)
      if (!entries.length && !Object.keys(series).length) {
        body.append(emptyState('暂无监控采样', { hint: '点击「立即刷新」采集监控数据。' }))
        return
      }
      if (entries.length) {
        const grid = el('div', { class: 'metric-grid' })
        for (const [key, value] of entries) {
          const spec = specMap.get(key)
          const warn = spec?.warnThreshold !== undefined && Number(value) > spec.warnThreshold
          const card = el('div', { class: `metric-card${warn ? ' metric-warn' : ''}` }, [
            el('div', { class: 'k', title: key }, labelOf(spec, key)),
            el('div', { class: 'v' }, fmtMetric(specMap, key, value))
          ])
          const spark = sparkline(series[key] ?? [])
          if (spark) card.appendChild(el('div', { class: 'spark', html: spark }))
          else if (Number.isFinite(Number(value))) {
            card.appendChild(el('div', { class: 'spark', style: 'color:var(--text-3);font-size:calc(var(--font-size-base, 13px) * 0.807692);display:flex;align-items:center' }, '采样中…'))
          }
          grid.appendChild(card)
        }
        body.appendChild(grid)
      } else if (Object.keys(series).length) {
        // 实时指标为空但存在历史采样：按 series 出趋势卡
        const grid = el('div', { class: 'metric-grid' })
        for (const [key, values] of Object.entries(series)) {
          if (!values.length) continue
          const spec = specMap.get(key)
          const card = el('div', { class: 'metric-card' }, [
            el('div', { class: 'k', title: key }, labelOf(spec, key)),
            el('div', { class: 'v' }, fmtMetric(specMap, key, values[values.length - 1]))
          ])
          const spark = sparkline(values)
          if (spark) card.appendChild(el('div', { class: 'spark', html: spark }))
          grid.appendChild(card)
        }
        body.appendChild(grid)
      }

      const brokers = Array.isArray(ov?.brokers) ? ov.brokers : []
      if (brokers.length) {
        const section = el('div', { class: 'broker-list' }, [
          el('div', { style: 'font-size:calc(var(--font-size-base, 13px) * 0.961538);font-weight:600;color:var(--text);margin:4px 0 10px' }, `Broker 状态（${brokers.length}）`)
        ])
        const g = simpleGrid({
          columns: [
            { key: 'id', title: 'ID', num: true, width: '90px', render: (r) => escapeHtml(String(r.id ?? '—')) },
            { key: 'host', title: '地址', mono: true, render: (r) => escapeHtml(String(r.host ?? '—')) },
            { key: 'roles', title: '角色', render: (r) => (r.roles ? escapeHtml(String(r.roles)) : '<span style="color:var(--text-3)">—</span>') },
            {
              key: 'alive', title: '状态', width: '110px',
              render: (r) => r.alive === undefined || r.alive === null
                ? '<span style="color:var(--text-3)">—</span>'
                : r.alive ? chip('在线', 'ok') : chip('离线', 'bad')
            }
          ],
          rowKey: (r) => `${r.id ?? ''}@${r.host ?? ''}`,
          emptyText: '无 broker 信息'
        })
        g.update(brokers)
        section.appendChild(g.root)
        body.appendChild(section)
      }

      const notes = Array.isArray(ov?.notes) ? ov.notes.filter(Boolean) : []
      if (notes.length) {
        body.appendChild(el('div', { class: 'broker-list' }, [
          el('div', { style: 'font-size:calc(var(--font-size-base, 13px) * 0.961538);font-weight:600;color:var(--text);margin:4px 0 10px' }, '说明'),
          ...notes.map((n) => el('div', { class: 'form-note', style: 'margin-bottom:8px' }, [
            el('span', {}, 'ℹ️'),
            el('span', { html: escapeHtml(String(n)) })
          ]))
        ]))
      }
      if (conn?.readOnly) {
        body.appendChild(el('div', { class: 'form-note', style: 'margin:0 16px 16px' }, [
          el('span', {}, '🔒'),
          el('span', {}, '只读连接：监控数据均为只读采样')
        ]))
      }
    }

    restore().then(() => { if (!autoOn && !body.childElementCount) sample(false) })
    this.__cleanup = () => {
      destroyed = true
      if (timer) { clearInterval(timer); timer = null }
    }
  },
  destroy() { this.__cleanup?.(); this.__cleanup = null }
}
