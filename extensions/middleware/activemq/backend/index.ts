/** ActiveMQ Classic / Artemis 驱动：Jolokia REST（:8161/console/jolokia，Basic 认证）。
 * Classic 经 hawtio console 内置 jolokia；Artemis 可用 native agent（:8774/jolokia）。
 * 队列/主题 = Broker MBean 的 Destinations；浏览/发送 = Queue/Topic MBean 的 browse/sendTextMessage。
 * DLQ：Classic 默认 ActiveMQ.DLQ（共享）或 IndividualDeadLetterQueue 策略；Artemis 为 ExpiryQueue/DLQ。 */
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
  MwTopicCreateInput
} from '../../../../packages/middleware-driver/mw-workbench'
import type { MwDriver, MwDriverContext, MwDriverHandle, MwTestResult } from '../../../../packages/middleware-driver/types'
import { unsupported } from '../../../../packages/middleware-driver/types'
import { mwHttp, mwHttpJson } from '../../../../packages/middleware-driver/httpRequest'

const CAPS: Record<string, { state: 'available' | 'unsupported'; reason?: string }> = {
  topicCrud: { state: 'available', reason: '队列/主题的创建/删除（经 Broker MBean）' },
  partitions: { state: 'unsupported', reason: 'JMS 无分区概念' },
  exchanges: { state: 'unsupported', reason: 'JMS 无交换机概念（Topic 即发布订阅）' },
  bindings: { state: 'unsupported', reason: 'JMS 无绑定概念' },
  consumerGroups: { state: 'available', reason: '持久订阅者（durable subscribers）' },
  offsetReset: { state: 'unsupported', reason: 'JMS 无消费位点' },
  clients: { state: 'available', reason: '连接（connections）列表' },
  clientKick: { state: 'unsupported', reason: 'Jolokia 未暴露连接级断开操作' },
  messageQuery: { state: 'available', reason: 'browse（仅队首快照，JMS browse 不消费）' },
  tail: { state: 'available', reason: '轮询 browse 增量（composite cursor 不暴露，按 JMSMessageID 去重）' },
  publish: { state: 'available' },
  resend: { state: 'available', reason: '重新 sendTextMessage' },
  trace: { state: 'unsupported', reason: 'ActiveMQ 无消息轨迹' },
  retained: { state: 'unsupported', reason: 'JMS 无 retained 概念' },
  configMgmt: { state: 'available', reason: '队列属性（经 MBean 属性读写）' },
  monitor: { state: 'available', reason: 'Broker 内存/存储/临时区占用' },
  dlqBrowse: { state: 'available', reason: '浏览 ActiveMQ.DLQ（或 Artemis DLQ）死信队列' }
}

const CONNECTION_FIELDS: MwConnectionField[] = [
  { key: 'jolokiaUrl', label: 'Jolokia 端点', type: 'text', required: true, pattern: 'https-url', placeholder: 'http://127.0.0.1:8161/console/jolokia', tip: 'Classic 用 console 内置 jolokia；Artemis 可用 native agent :8774/jolokia' },
  { key: 'brokerName', label: 'Broker 名称', type: 'text', placeholder: '缺省自动探测（localhost/第一个）', half: true },
  { key: 'username', label: '用户名', type: 'text', placeholder: 'admin', half: true },
  { key: 'secret', label: '密码', type: 'password', vaultSlot: 'primary' }
]

const PAGE_COLUMNS: MwPageColumns[] = [
  { page: 'topics', columns: [
    { key: 'name', title: '目的地', format: 'mono', width: '30%' },
    { key: 'type', title: '类型', format: 'chip' },
    { key: 'messageCount', title: '消息数', format: 'compact' },
    { key: 'consumerCount', title: '消费者', format: 'num' },
    { key: 'enqueueCount', title: '累计入队', format: 'compact', from: 'extras' },
    { key: 'dispatchedCount', title: '累计出队', format: 'compact', from: 'extras' }
  ] },
  { page: 'groups', columns: [
    { key: 'groupId', title: '持久订阅', format: 'mono', width: '30%' },
    { key: 'members', title: '消费者', format: 'num' },
    { key: 'totalLag', title: '积压', format: 'lag' },
    { key: 'state', title: '状态', format: 'chip' }
  ] },
  { page: 'clients', columns: [
    { key: 'clientId', title: '连接', format: 'mono', width: '36%' },
    { key: 'host', title: '远程地址', format: 'mono' },
    { key: 'connectedAt', title: '连接时间', format: 'datetime' }
  ] }
]

const METRICS_SPEC: MwMetricSpec[] = [
  { key: 'version', label: '版本', unit: 'text' },
  { key: 'memoryPercent', label: '内存占用', unit: 'percent' },
  { key: 'storePercent', label: '存储占用', unit: 'percent' },
  { key: 'tempPercent', label: '临时区占用', unit: 'percent' },
  { key: 'queues', label: '队列', unit: 'count' },
  { key: 'topics', label: 'Topic', unit: 'count' },
  { key: 'consumers', label: '消费者', unit: 'count' },
  { key: 'uptime', label: '运行时长', unit: 'ms' }
]

const SEND_FIELDS: MwSendField[] = [
  { key: 'key', label: 'JMSCorrelationID（可选）', type: 'text', placeholder: '关联 ID', half: true },
  { key: 'routingKey', label: 'JMSReplyTo（可选）', type: 'text', placeholder: '回复目的地', half: true }
]

interface AmqRuntime {
  base: string
  username: string
  password: string
  brokerMBean: string
  signal: AbortSignal
}

function rt(h: MwDriverHandle): AmqRuntime {
  return h.runtime as unknown as AmqRuntime
}

function auth(h: MwDriverHandle) {
  return { basicAuth: { username: rt(h).username, password: rt(h).password }, insecureTls: h.config.tlsRejectUnauthorized === false }
}

/** Jolokia 读 MBean 属性 */
async function read(h: MwDriverHandle, mbean: string, attribute: string): Promise<unknown> {
  const r = rt(h)
  return mwHttpJson<{ value: unknown }>(`${r.base}/read/${encodeURIComponent(mbean)}/${encodeURIComponent(attribute)}`, { ...auth(h), timeoutMs: 15000 }).then(res => res?.value)
}

/** Jolokia 执行 MBean 操作 */
async function exec(h: MwDriverHandle, mbean: string, operation: string, args: unknown[]): Promise<unknown> {
  const r = rt(h)
  const res = await mwHttpJson<{ value: unknown; error?: string; status?: number }>(`${r.base}/exec/${encodeURIComponent(mbean)}/${encodeURIComponent(operation)}/${args.map(a => encodeURIComponent(typeof a === 'string' ? a : JSON.stringify(a))).join('/')}`, { ...auth(h), timeoutMs: 30000 })
  if (res?.error) throw new Error(`Jolokia: ${res.error}`)
  return res?.value
}

/** Jolokia search（按 MBean 模式搜索） */
async function search(h: MwDriverHandle, pattern: string): Promise<string[]> {
  const r = rt(h)
  const res = await mwHttpJson<{ value: string[] }>(`${r.base}/search/${encodeURIComponent(pattern)}`, { ...auth(h), timeoutMs: 15000 })
  return res?.value ?? []
}

interface AmqDestination {
  Name?: string
  QueueSize?: number
  ConsumerCount?: number
  EnqueueCount?: number
  DequeueCount?: number
  DispatchedCount?: number
  MessagesSent?: number
  MessagesConsumed?: number
  MemoryPercentUsage?: number
  ['dlq']?: boolean
}

function toMwTopic(name: string, kindIsTopic: boolean, d: AmqDestination): MwTopic {
  const isDlq = /(^|\.)DLQ$/i.test(name) || name === 'ActiveMQ.DLQ' || name === 'ExpiryQueue' || name === 'DLQ'
  return {
    name,
    entity: kindIsTopic ? 'topic' : 'queue',
    messageCount: d?.QueueSize ?? d?.EnqueueCount ?? 0,
    consumerCount: d?.ConsumerCount ?? 0,
    type: isDlq ? 'dlq' : (kindIsTopic ? 'topic' : 'queue'),
    internal: isDlq,
    extras: {
      enqueueCount: Number(d?.EnqueueCount ?? d?.MessagesSent ?? 0),
      dispatchedCount: Number(d?.DequeueCount ?? d?.MessagesConsumed ?? 0)
    }
  }
}

export const activemqDriver: MwDriver = {
  kind: 'activemq',
  label: 'ActiveMQ / Artemis',
  transport: 'http',
  defaultPort: 8161,
  capabilities: CAPS,
  messageQueryModes: [],
  connectionFields: CONNECTION_FIELDS,
  pageColumns: PAGE_COLUMNS,
  metricsSpec: METRICS_SPEC,
  sendFields: SEND_FIELDS,

  async test(config, password) {
    const started = Date.now()
    try {
      const base = (config.jolokiaUrl ?? '').replace(/\/$/, '')
      if (!/^https?:\/\//.test(base)) throw new Error('Jolokia 端点必须以 http(s):// 开头')
      await mwHttpJson(`${base}/read/org.apache.activemq:type=Broker/BrokerId`, { basicAuth: { username: config.username ?? 'admin', password: password ?? 'admin' }, insecureTls: config.tlsRejectUnauthorized === false, timeoutMs: 8000 }).catch(async error => {
        // Classic BrokerId 属性名可能不同：改读 BrokerName 兜底
        const retry = await mwHttpJson(`${base}/read/org.apache.activemq:type=Broker/BrokerName`, { basicAuth: { username: config.username ?? 'admin', password: password ?? 'admin' }, insecureTls: config.tlsRejectUnauthorized === false, timeoutMs: 8000 }).catch(() => { throw error })
        return retry
      })
      return { ok: true, message: 'Jolokia 可达', latencyMs: Date.now() - started }
    } catch (error) {
      return { ok: false, message: `ActiveMQ Jolokia 连接失败：${(error as Error).message}`, latencyMs: Date.now() - started }
    }
  },

  async open(config, password, ctx) {
    ctx.signal.throwIfAborted()
    const base = (config.jolokiaUrl ?? '').replace(/\/$/, '')
    if (!/^https?:\/\//.test(base)) throw new Error('Jolokia 端点必须以 http(s):// 开头')
    const credentials = { basicAuth: { username: config.username ?? 'admin', password: password ?? 'admin' }, insecureTls: config.tlsRejectUnauthorized === false }
    // 探测 broker MBean：优先用户指定，其次 Classic 单实例，最后 search 第一个 Broker
    const candidates: string[] = []
    if (config.brokerName) candidates.push(`org.apache.activemq:type=Broker,brokerName=${config.brokerName}`)
    candidates.push('org.apache.activemq:type=Broker,brokerName=localhost')
    let brokerMBean = ''
    for (const candidate of candidates) {
      const probe = await mwHttpJson<{ value?: unknown; error?: string }>(`${base}/read/${encodeURIComponent(candidate)}/BrokerName`, { ...credentials, timeoutMs: 8000 }).catch(() => null)
      if (probe && !probe.error) { brokerMBean = candidate; break }
    }
    if (!brokerMBean) {
      const found = await mwHttpJson<{ value?: string[] }>(`${base}/search/org.apache.activemq:type=Broker,*`, { ...credentials, timeoutMs: 8000 }).catch(() => null)
      const first = found?.value?.[0]
      if (first) brokerMBean = first
    }
    if (!brokerMBean) throw new Error('未找到 Broker MBean：请确认 Jolokia 端点与 brokerName')
    ctx.signal.throwIfAborted()
    const runtime: AmqRuntime = {
      base,
      username: config.username ?? 'admin',
      password: password ?? 'admin',
      brokerMBean,
      signal: ctx.signal
    }
    return {
      kind: 'activemq', raw: null, config, readOnly: false, password,
      capabilities: { ...CAPS }, messageQueryModes: [],
      runtime: runtime as unknown as Record<string, unknown>
    }
  },

  async close() { /* Jolokia 无状态，无需清理 */ },

  async overview(h) {
    const version = await read(h, rt(h).brokerMBean, 'Version').catch(() => '')
    const [memoryPercent, storePercent, tempPercent, uptime] = await Promise.all([
      read(h, rt(h).brokerMBean, 'MemoryPercentUsage').catch(() => null),
      read(h, rt(h).brokerMBean, 'StorePercentUsage').catch(() => null),
      read(h, rt(h).brokerMBean, 'TempPercentUsage').catch(() => null),
      read(h, rt(h).brokerMBean, 'UptimeMillis').catch(() => null)
    ])
    const destinations = await read(h, rt(h).brokerMBean, 'Destinations').catch(() => null) as Record<string, unknown> | null
    let queues = 0, topics = 0, consumers = 0
    if (destinations && typeof destinations === 'object') {
      for (const key of Object.keys(destinations)) {
        if (key.startsWith('org.apache.activemq:brokerName')) {
          const value = destinations[key]
          if (key.includes('destinationType=Queue')) queues++
          else if (key.includes('destinationType=Topic')) topics++
          const asTopic = value as AmqDestination | undefined
          consumers += Number(asTopic?.ConsumerCount ?? 0)
        }
      }
    }
    return {
      kind: 'activemq',
      clusterName: String(version || ''),
      brokers: [{ id: 'broker', host: rt(h).base.replace(/^https?:\/\//, ''), roles: 'broker', alive: true }],
      metrics: {
        version: String(version || '—'),
        memoryPercent: Number(memoryPercent ?? -1),
        storePercent: Number(storePercent ?? -1),
        tempPercent: Number(tempPercent ?? -1),
        queues, topics, consumers,
        uptime: Number(uptime ?? 0)
      },
      notes: ['Artemis 的存储占用需 CLI/artemis 数据目录核对；此处读 Jolokia 暴露的百分比']
    } as MwOverview
  },

  async topicsList(h, input) {
    const destinations = await read(h, rt(h).brokerMBean, 'Destinations') as Record<string, AmqDestination>
    if (!destinations || typeof destinations !== 'object') return []
    const out: MwTopic[] = []
    for (const [mbean, d] of Object.entries(destinations)) {
      const nameMatch = mbean.match(/destinationName=([^,]+)/)
      if (!nameMatch) continue
      const name = decodeURIComponent(nameMatch[1])
      const isTopic = mbean.includes('destinationType=Topic')
      if (isTopic && /ActiveMQ\.Advisory/i.test(name)) continue
      if (!input.includeInternal && (/ActiveMQ\.Advisory/i.test(name) || name === 'ActiveMQ.DLQ')) continue
      if (input.search && !name.toLowerCase().includes(input.search.toLowerCase())) continue
      out.push(toMwTopic(name, isTopic, d))
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  },

  async topicDescribe(h, topic) {
    const isTopic = await this.topicsList(h, {}).then(list => list.find(t => t.name === topic)?.entity === 'topic')
    const mbean = destinationMBean(h, topic, isTopic)
    const attributes = ['QueueSize', 'ConsumerCount', 'EnqueueCount', 'DequeueCount', 'MemoryPercentUsage', 'DispatchedCount', 'InFlightCount']
    const configs: Record<string, string> = {}
    for (const attr of attributes) {
      const value = await read(h, mbean, attr).catch(() => undefined)
      if (value !== undefined) configs[attr] = String(value)
    }
    return { configs }
  },

  async topicCreate(h, input: MwTopicCreateInput) {
    const mbean = destinationMBean(h, input.name, input.type === 'topic')
    await exec(h, rt(h).brokerMBean, isQueueMBean(mbean) ? 'addQueue(java.lang.String)' : 'addTopic(java.lang.String)', [input.name])
  },

  async topicUpdate() {
    throw new Error('ActiveMQ 目的地属性经 MBean 逐项读写，暂不支持表单编辑')
  },

  async topicDelete(h, name) {
    const isTopic = await this.topicsList(h, {}).then(list => list.find(t => t.name === name)?.entity === 'topic')
    const mbean = destinationMBean(h, name, isTopic)
    await exec(h, rt(h).brokerMBean, isQueueMBean(mbean) ? 'removeQueue(java.lang.String)' : 'removeTopic(java.lang.String)', [name])
  },

  async topicPurge(h, name) {
    const mbean = destinationMBean(h, name, false)
    await exec(h, mbean, 'purge()', [])
  },

  partitionsGrow: async () => unsupported('分区管理'),

  exchangesList: async () => unsupported('交换机管理'),
  exchangeCreate: async () => unsupported('交换机管理'),
  exchangeDelete: async () => unsupported('交换机管理'),
  bindingsList: async () => unsupported('绑定管理'),
  bindingCreate: async () => unsupported('绑定管理'),
  bindingDelete: async () => unsupported('绑定管理'),

  async groupsList(h, input) {
    // 持久订阅者（Topic 的 durable subscribers）
    const durable = await read(h, rt(h).brokerMBean, 'DurableTopicSubscribers').catch(() => null) as Record<string, Record<string, unknown>> | null
    const out: MwConsumerGroup[] = []
    if (durable && typeof durable === 'object') {
      for (const [mbean, sub] of Object.entries(durable)) {
        const nameMatch = mbean.match(/destinationName=([^,]+)/)
        const clientIdMatch = mbean.match(/clientId=([^,]+)/)
        if (!nameMatch || !clientIdMatch) continue
        const topic = decodeURIComponent(nameMatch[1])
        const clientId = decodeURIComponent(clientIdMatch[1])
        const groupId = clientId || topic
        if (input.search && !groupId.toLowerCase().includes(input.search.toLowerCase())) continue
        out.push({
          groupId,
          state: sub?.Active ? 'running' : 'idle',
          members: 1,
          totalLag: Number(sub?.PendingQueueSize ?? 0),
          topics: [topic],
          extras: { topic, clientId, subscriptionName: String(sub?.SubscriptionName ?? '') }
        })
      }
    }
    return out
  },

  async groupDescribe(h, groupId) {
    const subs = await this.groupsList(h, {})
    const mine = subs.filter(s => s.groupId === groupId)
    const first = mine[0]
    if (!first) throw new Error(`持久订阅不存在：${groupId}`)
    const detail: MwConsumerGroupDetail = {
      groupId,
      state: first.state,
      members: mine.map(s => ({ clientId: String(s.extras?.clientId ?? s.groupId), topics: [String(s.extras?.topic ?? '')] })),
      offsets: mine.map(s => ({
        topic: String(s.extras?.topic ?? ''),
        currentOffset: 'n/a',
        logEndOffset: Number(s.totalLag ?? 0),
        lag: Number(s.totalLag ?? 0)
      }))
    }
    return detail
  },

  groupResetOffsets: async () => unsupported('offset 重置'),

  async clientsList(h, input) {
    const clients = await read(h, rt(h).brokerMBean, 'Clients').catch(() => null) as Record<string, Record<string, unknown>> | null
    if (!clients) return []
    const out: MwClient[] = []
    for (const [mbean, c] of Object.entries(clients)) {
      void mbean
      const clientId = String(c?.ClientId ?? c?.ConnectionID ?? '')
      if (!clientId) continue
      if (input.search && !clientId.toLowerCase().includes(input.search.toLowerCase())) continue
      out.push({
        clientId,
        host: String(c?.RemoteAddress ?? ''),
        connectedAt: Number(c?.ConnectedAt ?? 0) || undefined,
        extras: { sessions: Number(c?.SessionCount ?? 0), dispatchQueue: Number(c?.DispatchQueueSize ?? 0) }
      })
    }
    return out
  },

  clientKick: async () => unsupported('断开连接'),

  async messagesQuery(h, input: MwMessageQueryInput) {
    const list = await this.topicsList(h, {})
    const isTopic = list.find(t => t.name === input.topic)?.entity === 'topic'
    const mbean = destinationMBean(h, input.topic, isTopic)
    const count = Math.max(1, Math.min(Number(input.max) || 10, 200))
    const raw = await exec(h, mbean, 'browse()', []) as unknown[]
    const messages = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>
    return messages.slice(0, count).map(m => toAmqMessage(input.topic, m))
  },

  async messageGet(h, input) {
    const rows = await this.messagesQuery(h, { topic: input.topic, from: 'earliest', max: 1 })
    return rows[0] ?? null
  },

  async messageSend(h, input: MwMessageSendInput) {
    const list = await this.topicsList(h, {})
    const isTopic = list.find(t => t.name === input.topic)?.entity === 'topic'
    const mbean = destinationMBean(h, input.topic, isTopic)
    const headers = input.headers ?? {}
    // body, JMSCorrelationID, JMSReplyTo, Type, properties(3 个占位)
    const correlationId = String(headers['JMSCorrelationID'] ?? input.key ?? '')
    const replyTo = String(headers['JMSReplyTo'] ?? input.routingKey ?? '')
    await exec(h, mbean, `sendTextMessage(java.lang.String,java.lang.String,java.lang.String,java.lang.String,java.lang.String)`, [input.payload, correlationId, replyTo, '', ''])
    return { ok: true }
  },

  async messageResend(h, input) {
    return this.messageSend(h, {
      topic: input.targetTopic ?? input.message.topic,
      payload: input.message.payload,
      headers: input.message.headers
    })
  },

  async configsDescribe(h, input) {
    const detail = await this.topicDescribe(h, input.topic)
    return Object.entries(detail.configs ?? {}).map(([name, value]) => ({ name, value: String(value) }))
  },

  async configsAlter() {
    throw new Error('ActiveMQ 目的地配置经 MBean 逐项读写，暂不支持表单编辑')
  },

  traceMessage: async (): Promise<MwTrace> => unsupported('消息轨迹'),
  retainedList: async () => unsupported('retained 管理'),
  retainedDelete: async () => unsupported('retained 管理'),
  queueTemplate: async () => unsupported('死信/延迟模板'),

  async tailStart(h, input, sink) {
    const list = await this.topicsList(h, {})
    const isTopic = list.find(t => t.name === input.topic)?.entity === 'topic'
    const mbean = destinationMBean(h, input.topic, isTopic)
    const seen = new Set<string>()
    const signal = rt(h).signal
    const timer = setInterval(async () => {
      if (signal.aborted) return
      try {
        const raw = await exec(h, mbean, 'browse()', []).catch(() => null) as unknown[] | null
        const messages = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>
        for (const m of messages) {
          const id = String(m['JMSMessageID'] ?? '')
          if (!id || seen.has(id)) continue
          seen.add(id)
          if (seen.size > 5000) seen.clear()
          const message = toAmqMessage(input.topic, m)
          if (input.filter && !message.payload.includes(input.filter)) continue
          sink(message)
        }
      } catch { /* 轮询失败静默重试 */ }
    }, 2000)
    if (signal.aborted) clearInterval(timer)
    return {
      stop: async () => { clearInterval(timer) }
    }
  }
}

export default activemqDriver

/** Queue/Topic MBean 全名 */
function destinationMBean(h: MwDriverHandle, name: string, isTopic: boolean): string {
  const broker = rt(h).brokerMBean
  const type = isTopic ? 'Topic' : 'Queue'
  return `${broker},destinationName=${encodeURIComponent(name)},destinationType=${type}`
}

function isQueueMBean(mbean: string): boolean {
  return mbean.includes('destinationType=Queue')
}

function toAmqMessage(topic: string, m: Record<string, unknown>): MwMessage {
  const payload = String(m['Text'] ?? m['Body'] ?? m['text'] ?? '')
  const properties = (m['PropertiesText'] ?? '') as string
  const props: Record<string, string> = {}
  if (properties) {
    for (const pair of String(properties).split(/,\s*/)) {
      const idx = pair.indexOf('=')
      if (idx > 0) props[pair.slice(0, idx)] = pair.slice(idx + 1)
    }
  }
  return {
    messageId: String(m['JMSMessageID'] ?? ''),
    topic,
    timestamp: Number(m['JMSTimestamp'] ?? Date.now()),
    key: m['JMSCorrelationID'] ? String(m['JMSCorrelationID']) : undefined,
    payload,
    payloadType: payload.trim().startsWith('{') || payload.trim().startsWith('[') ? 'json' : 'text',
    properties: Object.keys(props).length ? props : undefined,
    redelivered: !!m['JMSRedelivered'],
    extras: {
      JMSDeliveryMode: String(m['JMSDeliveryMode'] ?? ''),
      JMSPriority: Number(m['JMSPriority'] ?? 0),
      JMSExpiration: Number(m['JMSExpiration'] ?? 0),
      mode: 'browse'
    }
  }
}
