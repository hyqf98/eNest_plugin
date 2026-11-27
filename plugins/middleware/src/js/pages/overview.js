/** 概览页：overview action → 指标卡（metricsSpec 描述符） + broker 列表 + 能力说明（手动刷新，不轮询） */
import { fmt, chip, el, emptyState, simpleGrid, escapeHtml, fmtMetricValue } from '@mw/components.js'
import { metricsSpecOf } from '@mw/kinds.js'

function fmtMetric(specMap, key, value) {
  const spec = specMap.get(key)
  if (spec) return fmtMetricValue(spec, value)
  // 兜底：动态键（$SYS 等）猜单位
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'string') return escapeHtml(value)
  const n = Number(value)
  if (!Number.isFinite(n)) return escapeHtml(String(value ?? '—'))
  if (/(bytes|size|disk|storage)/i.test(key) && !/rate/i.test(key)) return fmt.bytes(n)
  if (/(latency|duration|ms|time)\b/i.test(key)) return fmt.ms(n)
  return fmt.compact(n)
}

export default {
  id: 'overview',
  render(root, ctx) {
    const { api, conn } = ctx
    root.innerHTML = ''

    let data = null
    let destroyed = false

    const loading = el('div', { class: 'loading-bar' })
    const toolbar = el('div', { class: 'toolbar' }, [
      el('div', { style: 'display:flex;align-items:center;gap:8px;color:var(--text-3);font-size:calc(var(--font-size-base, 13px) * 0.923077)' }, [
        '概览数据每连接会话缓存，手动刷新',
        conn?.readOnly ? chip('只读连接', '') : ''
      ]),
      el('span', { style: 'flex:1' }),
      el('button', {
        class: 'btn',
        onclick: () => load(true)
      }, '⟳ 刷新')
    ])

    const body = el('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column;overflow-y:auto' })

    root.append(toolbar, body)

    function renderError(message) {
      body.innerHTML = ''
      body.appendChild(el('div', { class: 'empty-cap' }, [
        el('div', { class: 'big' }, '⚠️'),
        el('div', { style: 'margin-bottom:14px' }, `获取概览失败：${message}`),
        el('button', { class: 'btn primary', onclick: () => load(true) }, '重试')
      ]))
    }

    function renderOverview(ov) {
      body.innerHTML = ''
      // —— 指标卡片（描述符顺序；未声明回落 metrics 原始键序） ——
      const metrics = ov?.metrics && typeof ov.metrics === 'object' ? ov.metrics : {}
      const specList = ov?.metricSpecs?.length ? ov.metricSpecs : (metricsSpecOf(conn?.kind) ?? [])
      const specMap = new Map(specList.map(s => [s.key, s]))
      const entries = specList.length
        ? specList.map(s => [s.key, metrics[s.key]]).filter(([, v]) => v !== undefined)
        : Object.entries(metrics)
      if (entries.length) {
        const grid = el('div', { class: 'metric-grid' })
        for (const [key, value] of entries) {
          grid.appendChild(el('div', { class: 'metric-card' }, [
            el('div', { class: 'k', title: key }, specMap.get(key)?.label ?? key),
            el('div', { class: 'v' }, fmtMetric(specMap, key, value))
          ]))
        }
        body.appendChild(grid)
      }

      // —— broker 列表 ——
      const brokers = Array.isArray(ov?.brokers) ? ov.brokers : []
      if (brokers.length) {
        const section = el('div', { class: 'broker-list' }, [
          el('div', { style: 'font-size:calc(var(--font-size-base, 13px) * 0.961538);font-weight:600;color:var(--text);margin:4px 0 10px' },
            `Broker（${brokers.length}）`)
        ])
        const grid = simpleGrid({
          columns: [
            { key: 'id', title: 'ID', num: true, width: '90px', render: (r) => escapeHtml(String(r.id ?? '—')) },
            { key: 'host', title: '地址', mono: true, render: (r) => escapeHtml(String(r.host ?? '—')) },
            { key: 'roles', title: '角色', render: (r) => r.roles ? escapeHtml(String(r.roles)) : '<span style="color:var(--text-3)">—</span>' },
            {
              key: 'alive', title: '状态', width: '110px',
              render: (r) => {
                if (r.alive === undefined || r.alive === null) return '<span style="color:var(--text-3)">—</span>'
                return r.alive
                  ? chip('在线', 'ok')
                  : chip('离线', 'bad')
              }
            }
          ],
          rowKey: (r) => `${r.id ?? ''}@${r.host ?? ''}`,
          emptyText: '无 broker 信息'
        })
        grid.update(brokers)
        section.appendChild(grid.root)
        body.appendChild(section)
      }

      // —— notes 能力/降级说明 ——
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

      if (!entries.length && !brokers.length && !notes.length) {
        body.append(emptyState('暂无概览数据', { hint: '当前实例未返回指标或节点信息。' }))
      }
    }

    async function load(manual) {
      if (loading.parentNode !== root) {
        body.innerHTML = ''
        root.insertBefore(loading, body)
      }
      try {
        const ov = await api.mw('overview', { sessionKey: ctx.sessionKey })
        if (destroyed) return
        data = ov
        renderOverview(ov)
        if (manual) api.toast('已刷新', 'success')
      } catch (err) {
        if (destroyed) return
        renderError(err?.message || String(err))
      } finally {
        loading.remove()
      }
    }

    load(false)
  },
  destroy() { /* 无定时器/监听 */ }
}
