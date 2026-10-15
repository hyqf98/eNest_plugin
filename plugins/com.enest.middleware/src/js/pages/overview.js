/** 概览页：overview action → 指标卡片 + broker 列表 + 能力说明（手动刷新，不轮询） */
import { fmt, chip, el, simpleGrid, escapeHtml } from '@mw/components.js'

/* 指标值智能格式化：key 名提示单位，数值大小决定 num/bytes/ms */
const NUM_KEYS = /(count|total|topics|queues|groups|consumers|messages|messagesIn|bytesIn|connections|subscriptions|retained|znodes|brokers|partitions|replicas|underReplicated|active|pending|size|depth|lag|rate|tps|qps|latency|duration|uptime|since)/i
const BYTES_KEYS = /(bytes|size|disk|storage)/i
const MS_KEYS = /(latency|duration|ms|time)\b|latency/i

function fmtMetric(key, value) {
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'string') return escapeHtml(value)
  const n = Number(value)
  if (!Number.isFinite(n)) return escapeHtml(String(value ?? '—'))
  const k = String(key)
  if (BYTES_KEYS.test(k) && !/rate/i.test(k)) return fmt.bytes(n)
  if (MS_KEYS.test(k)) return fmt.ms(n)
  if (Number.isInteger(n) || NUM_KEYS.test(k)) return fmt.compact(n)
  // 比率/分数保留原值
  return String(value)
}

/* 指标 key → 中文可读标签（未命中直接展示原 key，避免瞎翻译） */
const LABELS = {
  topics: 'Topic', queues: '队列', exchanges: '交换机', bindings: '绑定',
  consumerGroups: '消费组', groups: '消费组', consumers: '消费者',
  brokers: 'Broker', controllers: 'Controller', partitions: '分区',
  underReplicated: '未同步分区', underReplicatedPartitions: '未同步分区',
  offlinePartitions: '离线分区', activeController: '活跃 Controller',
  messageCount: '消息总数', messagesInPerSec: '写入速率', bytesInPerSec: '写入吞吐',
  bytesOutPerSec: '读出吞吐', totalLag: '消费堆积', connections: '连接数',
  subscriptions: '订阅数', retained: 'Retained 消息', clients: '客户端',
  messagePublishRate: '发布速率', messageReceivedRate: '接收速率',
  publishRate: '发布速率', receivedRate: '接收速率',
  uptime: '运行时长', version: '版本', clusterName: '集群名', nodeCount: '节点数',
  queueCount: '队列', readyMessages: '就绪消息', unackedMessages: '未确认消息',
  channels: 'Channel', listeners: '监听器', objectTotals: '对象统计'
}

function labelOf(key) {
  if (LABELS[key]) return LABELS[key]
  const pretty = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return pretty.charAt(0).toUpperCase() + pretty.slice(1)
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
      // —— 指标卡片 ——
      const metrics = ov?.metrics && typeof ov.metrics === 'object' ? ov.metrics : {}
      const entries = Object.entries(metrics)
      if (entries.length) {
        const grid = el('div', { class: 'metric-grid' })
        for (const [key, value] of entries) {
          grid.appendChild(el('div', { class: 'metric-card' }, [
            el('div', { class: 'k', title: key }, labelOf(key)),
            el('div', { class: 'v' }, fmtMetric(key, value))
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
        body.appendChild(el('div', { class: 'empty-cap' }, ['该实例未返回概览数据']))
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
