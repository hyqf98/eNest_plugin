/** RabbitMQ 驱动：管理面走 15672 Management HTTP API；实时监听走 amqplib 直连
 * （consume 不 ack，channel 关闭时未确认消息自动回队，无副作用）。运行于 mwUtility。 */
import type { ChannelModel } from 'amqplib'
import type {
  MwClient,
  MwConnectionConfig,
  MwConnectionField,
  MwConsumerGroup,
  MwConsumerGroupDetail,
  MwMessage,
  MwMessageQueryInput,
  MwMessageSendInput,
  MwOverview,
  MwMetricSpec,
  MwPageColumns,
  MwTopic,
  MwTrace,
  MwSendField,
  MwBindingCreateInput,
  MwTopicCreateInput,
  MwQueueTemplateInput
} from '../../../../packages/middleware-driver/mw-workbench'
import type { MwDriver, MwDriverContext, MwDriverHandle, MwTestResult } from '../../../../packages/middleware-driver/types'
import { unsupported } from '../../../../packages/middleware-driver/types'
import { mwHttp, mwHttpJson } from '../../../../packages/middleware-driver/httpRequest'
import { createLazyResource, type LazyResource } from '../../../../packages/middleware-driver/lazyResource'

const amqpModule = createLazyResource(() => import('amqplib'))

const CAPS: Record<string, { state: 'available' | 'unsupported'; reason?: string }> = {
  topicCrud: { state: 'available', reason: '对应队列的创建/编辑/删除' },
  partitions: { state: 'unsupported', reason: 'AMQP 无分区概念' },
  exchanges: { state: 'available' },
  bindings: { state: 'available' },
  consumerGroups: { state: 'available', reason: '以队列维度展示消费者' },
  offsetReset: { state: 'unsupported', reason: 'AMQP 模型无消费位点；对应 requeue/purge' },
  clients: { state: 'available', reason: '连接（connections）列表' },
  clientKick: { state: 'available', reason: '强制断开连接' },
  messageQuery: { state: 'available', reason: '仅队头 peek（get+requeue）：消息会被确认后重新入队，顺序变化且带 redelivered 标记' },
  tail: { state: 'available', reason: 'amqplib 订阅，停止时未确认消息自动回队' },
  publish: { state: 'available' },
  resend: { state: 'available' },
  trace: { state: 'unsupported', reason: 'RabbitMQ 无消息轨迹' },
  retained: { state: 'unsupported', reason: 'AMQP 无 retained 概念' },
  configMgmt: { state: 'available', reason: '队列 arguments/policy' },
  monitor: { state: 'available' },
  dlqBrowse: { state: 'available', reason: '浏览死信队列（DLX 目标队列）后 get 重发' },
  dlqTemplates: { state: 'available', reason: '模板化死信/延迟队列一条龙' }
}

const CONNECTION_FIELDS: MwConnectionField[] = [
  { key: 'managementUrl', label: '管理端点', type: 'text', required: true, pattern: 'https-url', placeholder: 'http://10.2.1.21:15672', tip: '15672 管理面 API · 默认端口 15672' },
  { key: 'username', label: '用户名', type: 'text', placeholder: 'management 用户（guest 仅本机）', half: true },
  { key: 'secret', label: '密码', type: 'password', vaultSlot: 'primary', half: true },
  { key: 'vhost', label: 'vhost', type: 'text', placeholder: '/' }
]

/** 死信/延迟相关 arguments 的结构化提取（列表「死信去向」列与详情用） */
function dlqExtras(args?: Record<string, unknown>): Record<string, string | number | boolean> {
  if (!args) return {}
  const out: Record<string, string | number | boolean> = {}
  if (args['x-dead-letter-exchange'] !== undefined) out.dlx = String(args['x-dead-letter-exchange'])
  if (args['x-dead-letter-routing-key'] !== undefined) out.dlk = String(args['x-dead-letter-routing-key'])
  if (args['x-message-ttl'] !== undefined) out.ttl = Number(args['x-message-ttl'])
  if (args['x-expires'] !== undefined) out.queueExpires = Number(args['x-expires'])
  if (args['x-queue-type'] !== undefined) out.queueType = String(args['x-queue-type'])
  if (args['x-delayed-type'] !== undefined) out.delayedType = String(args['x-delayed-type'])
  return out
}

const PAGE_COLUMNS: MwPageColumns[] = [
  { page: 'queues', columns: [
    { key: 'name', title: '队列', format: 'mono', width: '26%' },
    { key: 'type', title: '类型', format: 'chip' },
    { key: 'messageCount', title: '消息数', format: 'compact' },
    { key: 'ready', title: '就绪', format: 'num', from: 'extras' },
    { key: 'consumerCount', title: '消费者', format: 'num' },
    { key: 'dlx', title: '死信去向', format: 'text', from: 'extras' },
    { key: 'ttl', title: 'TTL', format: 'ms', from: 'extras' },
    { key: 'durable', title: '持久化', format: 'bool' }
  ] },
  { page: 'exchanges', columns: [
    { key: 'name', title: '交换机', format: 'mono', width: '30%' },
    { key: 'type', title: '类型', format: 'chip' },
    { key: 'durable', title: '持久化', format: 'bool' },
    { key: 'autoDelete', title: '自动删除', format: 'bool' },
    { key: 'internal', title: '内部', format: 'bool' }
  ] },
  { page: 'bindings', columns: [
    { key: 'source', title: 'Source → Destination', format: 'mono', width: '40%', route: true },
    { key: 'routing_key', title: 'Routing Key', format: 'mono' },
    { key: 'properties_key', title: 'Properties Key', format: 'mono' }
  ] },
  { page: 'groups', columns: [
    { key: 'groupId', title: '队列（伪分组）', format: 'mono', width: '28%' },
    { key: 'members', title: '消费者', format: 'num' },
    { key: 'messageCount', title: '消息数', format: 'compact' },
    { key: 'ready', title: '就绪', format: 'num', from: 'extras' },
    { key: 'unacked', title: '未确认', format: 'num', from: 'extras' }
  ] },
  { page: 'clients', columns: [
    { key: 'clientId', title: '连接（Client ID）', format: 'mono', width: '30%' },
    { key: 'host', title: '来源地址', format: 'mono' },
    { key: 'connectedAt', title: '连接时间', format: 'datetime' },
    { key: 'subscriptionsCount', title: 'Channel/订阅', format: 'num' },
    { key: 'state', title: '状态', format: 'chip', from: 'extras' }
  ] }
]

const METRICS_SPEC: MwMetricSpec[] = [
  { key: 'version', label: '版本', unit: 'text' },
  { key: 'queues', label: '队列', unit: 'count' },
  { key: 'messages', label: '消息总数', unit: 'count' },
  { key: 'messagesReady', label: '就绪消息', unit: 'count' },
  { key: 'messagesUnacked', label: '未确认消息', unit: 'count' },
  { key: 'consumers', label: '消费者', unit: 'count' },
  { key: 'connections', label: '连接数', unit: 'count' },
  { key: 'publishRate', label: '发布速率', unit: 'rate' },
  { key: 'deliverRate', label: '投递速率', unit: 'rate' }
]

const SEND_FIELDS: MwSendField[] = [
  { key: 'routingKey', label: 'Routing Key（可选）', type: 'text', placeholder: '默认交换机按队列名路由' }
]

interface RmqRuntime {
  base: string
  username: string
  password: string
  vhost: string
  amqp: LazyResource<ChannelModel>
  signal: AbortSignal
  closing?: Promise<void>
  detachAbort?: () => void
}

function rt(h: MwDriverHandle): RmqRuntime {
  return h.runtime as unknown as RmqRuntime
}

function vhostPath(h: MwDriverHandle): string { return encodeURIComponent(rt(h).vhost || '/') }

function auth(h: MwDriverHandle) {
  return { basicAuth: { username: rt(h).username, password: rt(h).password }, insecureTls: h.config.tlsRejectUnauthorized === false }
}

function amqpUrlOf(config: MwConnectionConfig, password?: string): string {
  const url = new URL(config.managementUrl ?? '')
  const secure = url.protocol === 'https:'
  const port = url.port || (secure ? '5671' : '5672')
  return `${secure ? 'amqps' : 'amqp'}://${encodeURIComponent(config.username ?? 'guest')}:${encodeURIComponent(password ?? '')}@${url.hostname}:${port}/${encodeURIComponent(config.vhost || '/')}`
}

async function amqpOf(h: MwDriverHandle): Promise<ChannelModel> {
  const r = rt(h)
  if (h.closed) throw new Error('RabbitMQ connection is closing')
  r.signal.throwIfAborted()
  const connection = await r.amqp.get()
  r.signal.throwIfAborted()
  if (h.closed) throw new Error('RabbitMQ connection is closing')
  return connection
}

interface RmqQueue {
  name: string
  messages?: number
  consumers?: number
  durable?: boolean
  auto_delete?: boolean
  messages_ready?: number
  messages_unacknowledged?: number
  arguments?: Record<string, unknown>
  effective_policy_definition?: Record<string, unknown>
  node?: string
}
interface RmqExchange { name: string; type: string; durable: boolean; auto_delete: boolean; internal: boolean }
interface RmqBinding extends Record<string, unknown> { source: string; destination: string; destination_type: string; routing_key: string; properties_key: string }
interface RmqConnection { name?: string; user?: string; peer_host?: string; state?: string; channels?: number; recv_oct?: number; sent_oct?: number }
interface RmqConsumer { consumer_tag: string; queue: { name: string }; channel_details?: { peer_host?: string } }
interface RmqMessage {
  payload_bytes: number
  redelivered: boolean
  exchange: string
  routing_key: string
  payload: string
  properties?: Record<string, unknown>
}

function toMessage(queue: string, m: RmqMessage): MwMessage {
  const props = (m.properties ?? {}) as Record<string, unknown>
  const headers: Record<string, string> = {}
  for (const key of ['content_type', 'correlation_id', 'reply_to', 'message_id', 'type', 'app_id']) {
    const v = props[key]
    if (v !== undefined && v !== null) headers[key] = String(v)
  }
  if (props.headers && typeof props.headers === 'object') {
    for (const [k, v] of Object.entries(props.headers as Record<string, unknown>)) headers[k] = String(v)
  }
  const payload = m.payload ?? ''
  const trimmed = payload.trim()
  return {
    topic: queue,
    timestamp: Date.now(), // rmq get 不返回消息时间戳
    payload,
    payloadType: trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'text',
    headers: Object.keys(headers).length ? headers : undefined,
    redelivered: m.redelivered,
    payloadBytes: m.payload_bytes,
    extras: { routing_key: m.routing_key, exchange: m.exchange, mode: 'peek-requeue', no_timestamp: true }
  }
}

export const rabbitmqDriver: MwDriver = {
  kind: 'rabbitmq',
  label: 'RabbitMQ',
  transport: 'http',
  defaultPort: 15672,
  capabilities: CAPS,
  messageQueryModes: [],
  connectionFields: CONNECTION_FIELDS,
  pageColumns: PAGE_COLUMNS,
  metricsSpec: METRICS_SPEC,
  sendFields: SEND_FIELDS,

  async test(config, password) {
    const started = Date.now()
    try {
      const base = (config.managementUrl ?? '').replace(/\/$/, '')
      if (!/^https?:\/\//.test(base)) throw new Error('管理端点必须以 http(s):// 开头')
      await mwHttpJson(`${base}/api/overview`, { basicAuth: { username: config.username ?? 'guest', password: password ?? 'guest' }, insecureTls: config.tlsRejectUnauthorized === false, timeoutMs: 8000 })
      return { ok: true, message: '已连接管理面', latencyMs: Date.now() - started }
    } catch (error) {
      return { ok: false, message: `RabbitMQ 管理面连接失败：${(error as Error).message}`, latencyMs: Date.now() - started }
    }
  },

  async open(config, password, ctx) {
    ctx.signal.throwIfAborted()
    const base = (config.managementUrl ?? '').replace(/\/$/, '')
    if (!/^https?:\/\//.test(base)) throw new Error('管理端点必须以 http(s):// 开头')
    const [overview, exchanges] = await Promise.all([
      mwHttpJson<{ rabbitmq_version?: string; node?: string }>(`${base}/api/overview`, {
        basicAuth: { username: config.username ?? 'guest', password: password ?? 'guest' }, insecureTls: config.tlsRejectUnauthorized === false
      }),
      // 探测 delayed-message 插件：exchanges 列表出现 x-delayed-message 类型即已安装
      mwHttpJson<RmqExchange[]>(`${base}/api/exchanges/${encodeURIComponent(config.vhost || '/')}`, {
        basicAuth: { username: config.username ?? 'guest', password: password ?? 'guest' }, insecureTls: config.tlsRejectUnauthorized === false
      }).catch(() => [] as RmqExchange[])
    ])
    ctx.signal.throwIfAborted()
    const capabilities: Record<string, { state: 'available' | 'unsupported'; reason?: string }> = { ...CAPS }
    if ((exchanges ?? []).some(e => e.type === 'x-delayed-message')) {
      capabilities.delayQueue = { state: 'available', reason: 'x-delayed-message 插件已安装，支持延迟交换机' }
    } else {
      capabilities.delayQueue = { state: 'unsupported', reason: '未安装 rabbitmq_delayed_message_exchange 插件；延迟队列可用 TTL+DLQ 模板路线' }
    }
    const amqp = createLazyResource(async () => {
      ctx.signal.throwIfAborted()
      const module = await amqpModule.get()
      ctx.signal.throwIfAborted()
      return module.connect(amqpUrlOf(config, password))
    }, connection => connection.close())
    const runtime: RmqRuntime = {
      base, username: config.username ?? 'guest', password: password ?? 'guest',
      vhost: config.vhost || '/', amqp, signal: ctx.signal
    }
    const handle: MwDriverHandle = {
      kind: 'rabbitmq', raw: { version: overview?.rabbitmq_version }, config, readOnly: false, password,
      capabilities, messageQueryModes: [],
      runtime: runtime as unknown as Record<string, unknown>
    }
    const aborted = () => { void closeQuiet(handle) }
    runtime.detachAbort = () => ctx.signal.removeEventListener('abort', aborted)
    ctx.signal.addEventListener('abort', aborted, { once: true })
    return handle
  },

  async close(h) {
    await closeQuiet(h)
  },

  async overview(h) {
    const r = rt(h)
    const [ov, nodes] = await Promise.all([
      mwHttpJson<Record<string, any>>(`${r.base}/api/overview`, auth(h)),
      mwHttpJson<Array<Record<string, any>>>(`${r.base}/api/nodes`, auth(h))
    ])
    const totals = ov.queue_totals?.[0] ?? {}
    const rates = ov.message_stats ?? {}
    return {
      kind: 'rabbitmq',
      clusterName: ov.node,
      brokers: (nodes ?? []).map(n => ({
        id: String(n.name ?? ''),
        host: String(n.name ?? ''),
        roles: n.type === 'ram' ? 'ram' : 'disc',
        alive: n.running === true,
        extras: { memUsed: n.mem_used, diskFree: n.disk_free, uptime: n.uptime }
      })),
      metrics: {
        version: String(ov.rabbitmq_version ?? '—'),
        exchanges: ov.object_totals?.exchanges ?? 0,
        queues: ov.object_totals?.queues ?? 0,
        connections: ov.object_totals?.connections ?? 0,
        channels: ov.object_totals?.channels ?? 0,
        consumers: ov.object_totals?.consumers ?? 0,
        messages: totals.messages ?? 0,
        messagesReady: totals.messages_ready ?? 0,
        messagesUnacked: totals.messages_unacknowledged ?? 0,
        publishRate: rates.publish_details?.rate ?? 0,
        deliverRate: rates.deliver_details?.rate ?? 0
      },
      notes: ['实时监听经 amqp 直连（同主机 5672/5671 端口）']
    } as MwOverview
  },

  async topicsList(h, input) {
    const r = rt(h)
    const queues = await mwHttpJson<RmqQueue[]>(`${r.base}/api/queues/${vhostPath(h)}`, auth(h))
    return queues
      .filter(q => !input.search || q.name.toLowerCase().includes(input.search.toLowerCase()))
      .map(q => ({
        name: q.name,
        entity: 'queue' as const,
        messageCount: q.messages,
        consumerCount: q.consumers,
        durable: q.durable,
        autoDelete: q.auto_delete,
        type: String(q.arguments?.['x-queue-type'] ?? 'classic'),
        lag: q.messages_ready,
        extras: {
          ready: Number(q.messages_ready ?? 0),
          unacked: Number(q.messages_unacknowledged ?? 0),
          node: String(q.node ?? ''),
          ...dlqExtras(q.arguments)
        }
      }))
  },

  async topicDescribe(h, topic) {
    const r = rt(h)
    const q = await mwHttpJson<RmqQueue>(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(topic)}`, auth(h))
    return {
      configs: {
        durable: String(q.durable), autoDelete: String(q.auto_delete),
        type: String(q.arguments?.['x-queue-type'] ?? 'classic'),
        ...(q.effective_policy_definition ? { policy: JSON.stringify(q.effective_policy_definition) } : {})
      },
      extras: { arguments: q.arguments, ...dlqExtras(q.arguments) }
    }
  },

  async topicCreate(h, input: MwTopicCreateInput) {
    const r = rt(h)
    await mwHttp(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(input.name)}`, {
      method: 'PUT', ...auth(h),
      body: JSON.stringify({ durable: input.durable ?? true, auto_delete: input.autoDelete ?? false, arguments: input.arguments ?? {} })
    })
  },

  async topicUpdate(h, name, attrs) {
    const r = rt(h)
    // rmq 为幂等声明：durable 不可变更（服务端拒绝并报错），arguments/auto_delete 可改
    await mwHttp(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(name)}`, {
      method: 'PUT', ...auth(h),
      body: JSON.stringify({ durable: attrs.durable ?? true, auto_delete: attrs.autoDelete ?? false, arguments: attrs.arguments ?? {} })
    })
  },

  async topicDelete(h, name) {
    const r = rt(h)
    await mwHttp(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(name)}`, { method: 'DELETE', ...auth(h) })
  },

  async topicPurge(h, name) {
    const r = rt(h)
    await mwHttp(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(name)}/contents`, { method: 'DELETE', ...auth(h) })
  },

  partitionsGrow: async () => unsupported('分区管理'),

  async exchangesList(h, input) {
    const r = rt(h)
    const list = await mwHttpJson<RmqExchange[]>(`${r.base}/api/exchanges/${vhostPath(h)}`, auth(h))
    return list
      .filter(e => !e.internal)
      .filter(e => !input.search || e.name.toLowerCase().includes(input.search.toLowerCase()))
      .map(e => ({
        name: e.name === '' ? '(amq.default)' : e.name,
        entity: 'exchange' as const,
        type: e.type,
        durable: e.durable,
        autoDelete: e.auto_delete,
        internal: e.internal
      }))
  },

  async exchangeCreate(h, input) {
    const r = rt(h)
    await mwHttp(`${r.base}/api/exchanges/${vhostPath(h)}/${encodeURIComponent(input.name)}`, {
      method: 'PUT', ...auth(h),
      body: JSON.stringify({ type: input.type, durable: input.durable ?? true, auto_delete: input.autoDelete ?? false, arguments: input.arguments ?? {} })
    })
  },

  async exchangeDelete(h, name) {
    const r = rt(h)
    await mwHttp(`${r.base}/api/exchanges/${vhostPath(h)}/${encodeURIComponent(name)}`, { method: 'DELETE', ...auth(h) })
  },

  async bindingsList(h, input) {
    const r = rt(h)
    if (input.destination) {
      return mwHttpJson<RmqBinding[]>(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(input.destination)}/bindings`, auth(h))
    }
    const list = await mwHttpJson<RmqBinding[]>(`${r.base}/api/bindings/${vhostPath(h)}`, auth(h))
    return list.filter(b => !input.source || b.source === input.source)
  },

  async bindingCreate(h, input: MwBindingCreateInput) {
    const r = rt(h)
    const kind = input.destinationType === 'exchange' ? 'e' : 'q'
    await mwHttp(`${r.base}/api/bindings/${vhostPath(h)}/e/${encodeURIComponent(input.source || 'amq.default')}/${kind}/${encodeURIComponent(input.destination)}`, {
      method: 'POST', ...auth(h),
      body: JSON.stringify({ routing_key: input.routingKey ?? '', arguments: input.arguments ?? {} })
    })
  },

  async bindingDelete(h, input) {
    const r = rt(h)
    const all = await mwHttpJson<RmqBinding[]>(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(input.destination)}/bindings`, auth(h))
    const target = all.find(b => b.source === input.source && b.properties_key === input.propertiesKey)
    const kind = target?.destination_type === 'exchange' ? 'e' : 'q'
    await mwHttp(`${r.base}/api/bindings/${vhostPath(h)}/e/${encodeURIComponent(input.source || 'amq.default')}/${kind}/${encodeURIComponent(input.destination)}/${encodeURIComponent(input.propertiesKey)}`, {
      method: 'DELETE', ...auth(h)
    })
  },

  async groupsList(h, input) {
    const r = rt(h)
    const consumers = await mwHttpJson<RmqConsumer[]>(`${r.base}/api/consumers/${vhostPath(h)}`, auth(h))
    const byQueue = new Map<string, { count: number; hosts: Set<string> }>()
    for (const c of consumers) {
      const q = c.queue.name
      if (input.search && !q.toLowerCase().includes(input.search.toLowerCase())) continue
      const entry = byQueue.get(q) ?? { count: 0, hosts: new Set<string>() }
      entry.count++
      if (c.channel_details?.peer_host) entry.hosts.add(c.channel_details.peer_host)
      byQueue.set(q, entry)
    }
    return [...byQueue.entries()].map(([queue, v]) => ({
      groupId: queue,
      state: 'running',
      members: v.count,
      extras: { hosts: [...v.hosts].join(',') }
    })) as MwConsumerGroup[]
  },

  async groupDescribe(h, groupId) {
    const r = rt(h)
    const [q, consumers] = await Promise.all([
      mwHttpJson<RmqQueue>(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(groupId)}`, auth(h)).catch(() => null),
      mwHttpJson<RmqConsumer[]>(`${r.base}/api/consumers/${vhostPath(h)}`, auth(h))
    ])
    if (!q) throw new Error(`队列不存在：${groupId}`)
    const mine = consumers.filter(c => c.queue.name === groupId)
    const detail: MwConsumerGroupDetail = {
      groupId,
      state: mine.length ? 'running' : 'idle',
      members: mine.map(c => ({ clientId: c.consumer_tag, host: c.channel_details?.peer_host })),
      offsets: [{
        topic: groupId,
        currentOffset: 'n/a',
        logEndOffset: q.messages ?? 0,
        lag: q.messages_ready ?? 0
      }]
    }
    return detail
  },

  groupResetOffsets: async () => unsupported('offset 重置'),

  async clientsList(h, input) {
    const r = rt(h)
    const list = await mwHttpJson<RmqConnection[]>(`${r.base}/api/connections/${vhostPath(h)}`, auth(h))
    return list
      .filter(c => !input.search || (c.user ?? '').includes(input.search) || (c.peer_host ?? '').includes(input.search))
      .map(c => ({
        clientId: c.name ?? `${c.user}@${c.peer_host}`,
        host: c.peer_host,
        extras: { user: c.user, state: c.state, channels: c.channels, recv: c.recv_oct, sent: c.sent_oct }
      })) as MwClient[]
  },

  async clientKick(h, clientId) {
    const r = rt(h)
    await mwHttp(`${r.base}/api/connections/${encodeURIComponent(clientId)}`, { method: 'DELETE', ...auth(h) })
  },

  async messagesQuery(h, input: MwMessageQueryInput) {
    const r = rt(h)
    const count = Math.max(1, Math.min(Number(input.max) || 10, 200))
    const result = await mwHttpJson<RmqMessage[] | RmqMessage>(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(input.topic)}/get`, {
      method: 'POST', ...auth(h),
      body: JSON.stringify({ count, ackmode: 'ack_requeue_true', encoding: 'auto', truncate: 50000 })
    })
    const list = Array.isArray(result) ? result : [result]
    return list.map(m => toMessage(input.topic, m))
  },

  async messageGet(h, input) {
    const rows = await this.messagesQuery(h, { topic: input.topic, from: 'earliest', max: 1 })
    return rows[0] ?? null
  },

  async messageSend(h, input: MwMessageSendInput) {
    const r = rt(h)
    const exchange = input.topic || 'amq.default'
    const result = await mwHttpJson<{ routed: boolean }>(`${r.base}/api/exchanges/${vhostPath(h)}/${encodeURIComponent(exchange)}/publish`, {
      method: 'POST', ...auth(h),
      body: JSON.stringify({
        properties: {
          content_type: input.headers?.['content_type'] ?? 'application/json',
          ...(input.headers ? { headers: input.headers } : {})
        },
        routing_key: input.routingKey ?? input.key ?? '',
        payload: input.payload,
        payload_encoding: input.payloadEncoding === 'base64' ? 'base64' : 'string'
      })
    })
    return { ok: true, detail: result?.routed ? '已路由到队列' : '未路由（无匹配绑定）' }
  },

  async messageResend(h, input) {
    const message = input.message
    const isQueue = !input.targetTopic
    return this.messageSend(h, {
      topic: isQueue ? 'amq.default' : input.targetTopic!,
      payload: message.payload,
      payloadEncoding: message.payloadEncoding,
      routingKey: isQueue ? message.topic : String(message.extras?.routing_key ?? ''),
      headers: message.headers
    })
  },

  async configsDescribe(h, input) {
    const detail = await this.topicDescribe(h, input.topic)
    return Object.entries(detail.configs ?? {}).map(([name, value]) => ({ name, value: String(value) }))
  },

  async configsAlter(h, input) {
    const detail = await this.topicDescribe(h, input.topic)
    const merged: Record<string, unknown> = { ...((detail.extras?.arguments as Record<string, unknown>) ?? {}) }
    for (const [k, v] of Object.entries(input.configs)) if (k !== 'durable') merged[k] = v
    const r = rt(h)
    await mwHttp(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(input.topic)}`, {
      method: 'PUT', ...auth(h),
      body: JSON.stringify({
        durable: detail.configs?.durable === 'true', auto_delete: detail.configs?.autoDelete === 'true',
        arguments: merged
      })
    })
  },

  traceMessage: async (): Promise<MwTrace> => unsupported('消息轨迹'),
  retainedList: async () => unsupported('retained 管理'),
  retainedDelete: async () => unsupported('retained 管理'),

  /** 死信/延迟队列模板：
   *  - dlq：为既有 queue 配死信（建 {queue}.dlx direct 交换机 + {queue}.dlq 队列 + 绑定 + 回写源队列 arguments）
   *  - delay(usePlugin)：建 x-delayed-message 交换机 + 目标队列 + 绑定，发送时带 x-delay 头
   *  - delay(TTL 路线)：建 TTL 缓冲队列（无消费者）+ DLX 交换机 + 目标队列 + 绑定，消息到期死信转发 */
  async queueTemplate(h, input) {
    const r = rt(h)
    const durable = input.durable ?? true
    const created: string[] = []
    if (input.template === 'dlq') {
      const queue = input.queue
      const exchange = input.exchange || `${queue}.dlx`
      const dlq = input.dlq || `${queue}.dlq`
      // 1. 死信交换机（direct）
      await mwHttp(`${r.base}/api/exchanges/${vhostPath(h)}/${encodeURIComponent(exchange)}`, {
        method: 'PUT', ...auth(h),
        body: JSON.stringify({ type: 'direct', durable, auto_delete: false, arguments: {} })
      })
      created.push(`exchange:${exchange}`)
      // 2. 死信队列
      await mwHttp(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(dlq)}`, {
        method: 'PUT', ...auth(h),
        body: JSON.stringify({ durable, auto_delete: false, arguments: {} })
      })
      created.push(`queue:${dlq}`)
      // 3. 交换机 → 死信队列绑定（routing key 默认用源队列名，与 x-dead-letter-routing-key 一致）
      const routingKey = input.routingKey || queue
      await mwHttp(`${r.base}/api/bindings/${vhostPath(h)}/e/${encodeURIComponent(exchange)}/q/${encodeURIComponent(dlq)}`, {
        method: 'POST', ...auth(h),
        body: JSON.stringify({ routing_key: routingKey, arguments: {} })
      })
      created.push(`binding:${exchange}→${dlq}`)
      // 4. 源队列回写死信 arguments（保留既有 arguments，幂等声明）
      const existing = await mwHttpJson<RmqQueue>(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(queue)}`, auth(h))
      const args: Record<string, unknown> = { ...(existing.arguments ?? {}), 'x-dead-letter-exchange': exchange, 'x-dead-letter-routing-key': routingKey }
      await mwHttp(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(queue)}`, {
        method: 'PUT', ...auth(h),
        body: JSON.stringify({ durable: existing.durable ?? durable, auto_delete: existing.auto_delete ?? false, arguments: args })
      })
      created.push(`queue-args:${queue}`)
      return { created }
    }
    // delay 模板
    const target = input.queue
    const ttl = Number(input.ttlMs) || 60000
    if (input.usePlugin) {
      if (h.capabilities.delayQueue?.state !== 'available') {
        throw new Error('服务端未安装 rabbitmq_delayed_message_exchange 插件，请改用 TTL+DLQ 路线')
      }
      const exchange = input.exchange || 'delay.exchange'
      await mwHttp(`${r.base}/api/exchanges/${vhostPath(h)}/${encodeURIComponent(exchange)}`, {
        method: 'PUT', ...auth(h),
        body: JSON.stringify({ type: 'x-delayed-message', durable, auto_delete: false, arguments: { 'x-delayed-type': 'direct' } })
      })
      created.push(`exchange:${exchange}(x-delayed-message)`)
      await mwHttp(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(target)}`, {
        method: 'PUT', ...auth(h),
        body: JSON.stringify({ durable, auto_delete: false, arguments: {} })
      })
      created.push(`queue:${target}`)
      await mwHttp(`${r.base}/api/bindings/${vhostPath(h)}/e/${encodeURIComponent(exchange)}/q/${encodeURIComponent(target)}`, {
        method: 'POST', ...auth(h),
        body: JSON.stringify({ routing_key: input.routingKey || target, arguments: {} })
      })
      created.push(`binding:${exchange}→${target}`)
      return { created }
    }
    // TTL+DLX 路线：buffer 队列带 TTL + 死信到 delay.exchange
    const exchange = input.exchange || 'delay.exchange'
    const buffer = `${target}.delay`
    await mwHttp(`${r.base}/api/exchanges/${vhostPath(h)}/${encodeURIComponent(exchange)}`, {
      method: 'PUT', ...auth(h),
      body: JSON.stringify({ type: 'direct', durable, auto_delete: false, arguments: {} })
    })
    created.push(`exchange:${exchange}`)
    await mwHttp(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(target)}`, {
      method: 'PUT', ...auth(h),
      body: JSON.stringify({ durable, auto_delete: false, arguments: {} })
    })
    created.push(`queue:${target}`)
    await mwHttp(`${r.base}/api/queues/${vhostPath(h)}/${encodeURIComponent(buffer)}`, {
      method: 'PUT', ...auth(h),
      body: JSON.stringify({ durable, auto_delete: false, arguments: { 'x-message-ttl': ttl, 'x-dead-letter-exchange': exchange } })
    })
    created.push(`queue:${buffer}(TTL=${ttl}ms)`)
    await mwHttp(`${r.base}/api/bindings/${vhostPath(h)}/e/${encodeURIComponent(exchange)}/q/${encodeURIComponent(target)}`, {
      method: 'POST', ...auth(h),
      body: JSON.stringify({ routing_key: input.routingKey || target, arguments: {} })
    })
    created.push(`binding:${exchange}→${target}`)
    return { created }
  },

  async tailStart(h, input, sink) {
    const conn = await amqpOf(h)
    const channel = await conn.createChannel()
    await channel.prefetch(50)
    await channel.consume(input.topic, msg => {
      if (!msg) return
      const payload = msg.content.toString('utf8')
      const trimmed = payload.trim()
      const headers: Record<string, string> = {}
      const rawHeaders = msg.properties.headers as Record<string, unknown> | undefined
      if (rawHeaders) for (const [k, v] of Object.entries(rawHeaders)) headers[k] = String(v)
      sink({
        topic: input.topic,
        timestamp: Date.now(),
        payload,
        payloadType: trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'text',
        headers: Object.keys(headers).length ? headers : undefined,
        redelivered: msg.fields.redelivered,
        payloadBytes: msg.content.length,
        extras: { routing_key: msg.fields.routingKey, exchange: msg.fields.exchange, mode: 'consume-requeue' }
      })
      // 永不 ack：channel 关闭时未确认消息自动回队
    }, { noAck: false })
    return {
      stop: async () => {
        await channel.close().catch(() => undefined)
      }
    }
  }
}

export default rabbitmqDriver

function closeQuiet(h: MwDriverHandle): Promise<void> {
  const r = h.runtime as RmqRuntime | undefined
  h.closed = true
  if (!r) return Promise.resolve()
  if (r.closing) return r.closing
  r.detachAbort?.()
  r.closing = r.amqp.close().catch(() => undefined)
  return r.closing
}
