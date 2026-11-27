/** Apache Pulsar 驱动：管理面 REST（:8080 /admin/v2，Bearer token）+ WebSocket produce/consume（:8080/ws）。
 * topic 形如 persistent://tenant/namespace/topic；分区 topic = partitioned topic。
 * 订阅 = cursor（groupResetOffsets → resetCursor）；消息查询 = exclusive consumer peek。 */
import type WebSocket from 'ws'
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
import { createLazyResource, type LazyResource } from '../../../../packages/middleware-driver/lazyResource'

const wsModule = createLazyResource(() => import('ws').then(module => module.default))

const CAPS: Record<string, { state: 'available' | 'unsupported'; reason?: string }> = {
  topicCrud: { state: 'available', reason: 'partitioned/non-partitioned topic CRUD' },
  partitions: { state: 'available', reason: 'partitioned topic 分区数（只能增加）' },
  exchanges: { state: 'unsupported', reason: 'Pulsar 无交换机概念' },
  bindings: { state: 'unsupported', reason: 'Pulsar 无绑定概念' },
  consumerGroups: { state: 'available', reason: 'subscription（游标）' },
  offsetReset: { state: 'available', reason: 'resetCursor（重置订阅游标）' },
  clients: { state: 'available', reason: 'broker 列表；runtime 连接需 Prometheus' },
  clientKick: { state: 'unsupported', reason: 'REST 未暴露连接级断开' },
  messageQuery: { state: 'available', reason: 'peek（经 exclusive consumer，仅订阅头几条）' },
  tail: { state: 'available', reason: 'WebSocket consumer 实时监听' },
  publish: { state: 'available', reason: 'WebSocket producer' },
  resend: { state: 'available' },
  trace: { state: 'unsupported', reason: 'Pulsar 无消息轨迹' },
  retained: { state: 'unsupported', reason: 'Pulsar 无 retained 概念' },
  configMgmt: { state: 'available', reason: 'topic policies（保留策略/ TTL 等）' },
  monitor: { state: 'available', reason: 'brokers/health + 内置 metrics 采样' },
  dlqBrowse: { state: 'available', reason: '重试/死信 topic（-RETRY/-DLQ 后缀）浏览与重发' }
}

const CONNECTION_FIELDS: MwConnectionField[] = [
  { key: 'serviceUrl', label: 'Web 服务地址', type: 'text', required: true, pattern: 'https-url', placeholder: 'http://127.0.0.1:8080', tip: 'REST /admin/v2 与 WebSocket /ws 同源推导 · 默认端口 8080' },
  { key: 'secret', label: 'JWT Token（vault 托管）', type: 'password', vaultSlot: 'primary', placeholder: '匿名集群可留空' },
  { key: 'tenant', label: '默认 tenant/namespace', type: 'text', placeholder: 'public/default（浏览全部可留空）', tip: 'topics.list 按该前缀过滤；topic 操作可用完整 URI' }
]

const PAGE_COLUMNS: MwPageColumns[] = [
  { page: 'topics', columns: [
    { key: 'name', title: 'TOPIC', format: 'mono', width: '36%' },
    { key: 'type', title: '类型', format: 'type' },
    { key: 'partitions', title: '分区', format: 'num' },
    { key: 'messageCount', title: '积压估算', format: 'compact' },
    { key: 'subscriptions', title: '订阅', format: 'num', from: 'extras' },
    { key: 'lag', title: '堆积', format: 'lag' }
  ] },
  { page: 'groups', columns: [
    { key: 'groupId', title: '订阅', format: 'mono', width: '30%' },
    { key: 'state', title: '类型', format: 'chip' },
    { key: 'members', title: '消费者', format: 'num' },
    { key: 'totalLag', title: '积压', format: 'lag' },
    { key: 'topics', title: '订阅 Topic', format: 'num' }
  ] },
  { page: 'clients', columns: [
    { key: 'clientId', title: 'Broker', format: 'mono', width: '30%' },
    { key: 'host', title: '地址', format: 'mono' },
    { key: 'connectedAt', title: '版本', format: 'text' }
  ] }
]

const METRICS_SPEC: MwMetricSpec[] = [
  { key: 'version', label: '版本', unit: 'text' },
  { key: 'brokers', label: 'Broker', unit: 'count' },
  { key: 'tenants', label: 'Tenant', unit: 'count' },
  { key: 'namespaces', label: 'Namespace', unit: 'count' },
  { key: 'topics', label: 'Topic', unit: 'count' },
  { key: 'bundles', label: 'Bundle', unit: 'count' }
]

const SEND_FIELDS: MwSendField[] = [
  { key: 'key', label: 'Key（可选，分区路由用）', type: 'text', placeholder: '缺省轮询', half: true },
  { key: 'partition', label: '分区（可选）', type: 'number', placeholder: '缺省自动', min: 0, half: true }
]

interface PulsarRuntime {
  base: string
  token?: string
  tenantPrefix?: string
  signal: AbortSignal
  /** 复用的 producer WebSocket */
  producer?: LazyResource<WebSocket>
}

function rt(h: MwDriverHandle): PulsarRuntime {
  return h.runtime as unknown as PulsarRuntime
}

function auth(h: MwDriverHandle) {
  const r = rt(h)
  return { bearerToken: r.token, insecureTls: h.config.tlsRejectUnauthorized === false, timeoutMs: 20000 }
}

function adminUrl(h: MwDriverHandle, path: string): string {
  return `${rt(h).base}/admin/v2/${path.replace(/^\//, '')}`
}

function wsUrlOf(h: MwDriverHandle, query: Record<string, string>): string {
  const base = rt(h).base.replace(/^http/, 'ws')
  const params = new URLSearchParams(query)
  return `${base}/ws/producer?${params.toString()}`
}

function topicRest(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/')
}

/** 完整 topic URI：裸名补 public/default 前缀 */
function fullTopic(h: MwDriverHandle, name: string): string {
  if (/^(persistent|non-persistent):\/\//.test(name)) return name
  const raw = rt(h).tenantPrefix
  const prefix = raw && raw.includes('/') ? raw : 'public/default'
  return `persistent://${prefix}/${name}`
}

function shortTopic(name: string): string {
  const match = name.match(/^(persistent|non-persistent):\/\/[^/]+\/[^/]+\/(.+)$/)
  return match ? match[2] : name
}

interface PulsarTopicStats { subscriptions?: Record<string, unknown>; backlogSize?: number; msgInCounter?: number; msgOutCounter?: number }

function toMwMessage(topic: string, payload: string, properties?: Record<string, string>, messageId?: string, publishTime?: number): MwMessage {
  return {
    messageId,
    topic: shortTopic(topic),
    timestamp: publishTime ?? Date.now(),
    payload,
    payloadType: payload.trim().startsWith('{') || payload.trim().startsWith('[') ? 'json' : 'text',
    properties,
    payloadBytes: Buffer.byteLength(payload),
    extras: { fullTopic: topic, mode: 'ws' }
  }
}

export const pulsarDriver: MwDriver = {
  kind: 'pulsar',
  label: 'Apache Pulsar',
  transport: 'http',
  defaultPort: 8080,
  capabilities: CAPS,
  messageQueryModes: [],
  connectionFields: CONNECTION_FIELDS,
  pageColumns: PAGE_COLUMNS,
  metricsSpec: METRICS_SPEC,
  sendFields: SEND_FIELDS,

  async test(config, password) {
    const started = Date.now()
    try {
      const base = (config.serviceUrl ?? '').replace(/\/$/, '')
      if (!/^https?:\/\//.test(base)) throw new Error('服务地址必须以 http(s):// 开头')
      await mwHttpJson(`${base}/admin/v2/brokers/health`, { bearerToken: password, insecureTls: config.tlsRejectUnauthorized === false, timeoutMs: 8000 })
      return { ok: true, message: 'Broker 健康', latencyMs: Date.now() - started }
    } catch (error) {
      return { ok: false, message: `Pulsar 连接失败：${(error as Error).message}`, latencyMs: Date.now() - started }
    }
  },

  async open(config, password, ctx) {
    ctx.signal.throwIfAborted()
    const base = (config.serviceUrl ?? '').replace(/\/$/, '')
    if (!/^https?:\/\//.test(base)) throw new Error('服务地址必须以 http(s):// 开头')
    await mwHttpJson(`${base}/admin/v2/brokers/health`, { bearerToken: password, insecureTls: config.tlsRejectUnauthorized === false })
    ctx.signal.throwIfAborted()
    const producer = createLazyResource(async () => {
      const WS = await wsModule.get()
      return new Promise<WebSocket>((resolve, reject) => {
        const socket = new WS(`${base.replace(/^http/, 'ws')}/ws/producer`, { headers: password ? { authorization: `Bearer ${password}` } : {} })
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('Pulsar producer WebSocket 握手超时')) }, 10000)
        socket.once('open', () => { clearTimeout(timer); resolve(socket) })
        socket.once('error', error => { clearTimeout(timer); reject(error) })
      })
    }, closeSocket)
    const runtime: PulsarRuntime = { base, token: password, tenantPrefix: String(config.options?.tenant ?? ''), signal: ctx.signal, producer }
    return {
      kind: 'pulsar', raw: null, config, readOnly: false, password,
      capabilities: { ...CAPS }, messageQueryModes: [],
      runtime: runtime as unknown as Record<string, unknown>
    }
  },

  async close(h) {
    const r = rt(h)
    h.closed = true
    await r.producer?.close().catch(() => undefined)
  },

  async overview(h) {
    const [version, brokers, tenants] = await Promise.all([
      mwHttpJson<{ version?: string }>(adminUrl(h, 'brokers/internal-configuration'), auth(h)).catch(() => ({}) as { version?: string }),
      mwHttpJson<Array<Record<string, string>>>(adminUrl(h, 'brokers'), auth(h)).catch(() => [] as Array<Record<string, string>>),
      mwHttpJson<string[]>(adminUrl(h, 'tenants'), auth(h)).catch(() => [] as string[])
    ])
    let namespaces = 0, topics = 0
    for (const tenant of tenants.slice(0, 10)) {
      const ns = await mwHttpJson<string[]>(adminUrl(h, `namespaces/${tenant}`), { ...auth(h), timeoutMs: 8000 }).catch(() => [] as string[])
      namespaces += ns.length
      for (const namespace of ns.slice(0, 20)) {
        const parts = await mwHttpJson<{ partitions?: number }>(adminUrl(h, `namespaces/${tenant}/${namespace.replace(`${tenant}/`, '')}/partitions`), { ...auth(h), timeoutMs: 8000 }).catch(() => ({}) as { partitions?: number })
        topics += Number(parts?.partitions ?? 0)
      }
    }
    return {
      kind: 'pulsar',
      clusterName: String((version as Record<string, unknown>)?.zookeeperServers ?? '').slice(0, 40) || undefined,
      brokers: (brokers ?? []).map(b => ({ id: String(b['brokerId'] ?? ''), host: String(b['brokerUrl'] ?? b['serviceUrl'] ?? ''), roles: 'broker', alive: true })),
      metrics: {
        version: String((version as Record<string, unknown>)?.version ?? '—'),
        brokers: (brokers ?? []).length,
        tenants: tenants.length,
        namespaces,
        topics
      },
      notes: ['Topic 计数经 tenants→namespaces 聚合采样；吞吐/积压趋势需 Prometheus 指标面']
    } as MwOverview
  },

  async topicsList(h, input) {
    const prefix = input.search ? `${input.search}` : (rt(h).tenantPrefix || '')
    const scope = prefix && prefix.includes('/') ? `persistent/${prefix}` : (prefix ? `persistent/${prefix}` : 'persistent')
    const list = await mwHttpJson<string[]>(adminUrl(h, `namespaces/${scope.split('/').slice(1).join('/') || 'public/default'}/topics`), auth(h)).catch(async () => {
      // 前缀非 namespace：退回 tenant 全量
      const tenant = prefix.split('/')[0] || 'public'
      return mwHttpJson<string[]>(adminUrl(h, `tenants/${tenant}/topics`), auth(h)).catch(() => [] as string[])
    })
    const out: MwTopic[] = []
    for (const topic of (list ?? []).slice(0, 200)) {
      const full = fullTopic(h, topic)
      if (input.search && !full.toLowerCase().includes(input.search.toLowerCase())) continue
      const [meta, stats] = await Promise.all([
        mwHttpJson<{ partitions?: number }>(`${adminUrl(h, topicRest(full))}/partitions`, auth(h)).catch(() => ({}) as { partitions?: number }),
        mwHttpJson<PulsarTopicStats>(`${adminUrl(h, topicRest(full))}/stats`, { ...auth(h), timeoutMs: 8000 }).catch(() => ({}) as PulsarTopicStats)
      ])
      const partitioned = meta?.partitions !== undefined
      let lag = 0
      for (const sub of Object.values(stats?.subscriptions ?? {})) lag += Number((sub as Record<string, unknown>)?.msgBacklog ?? 0)
      out.push({
        name: shortTopic(full),
        entity: 'topic',
        partitions: partitioned ? Number(meta.partitions) : 1,
        type: partitioned ? 'partitioned' : 'normal',
        messageCount: Number(stats?.msgInCounter ?? 0),
        consumerCount: Object.keys(stats?.subscriptions ?? {}).length,
        lag,
        extras: { fullTopic: full, subscriptions: Object.keys(stats?.subscriptions ?? {}).length, backlogBytes: Number(stats?.backlogSize ?? 0) }
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  },

  async topicDescribe(h, topic) {
    const full = fullTopic(h, topic)
    const [meta, stats] = await Promise.all([
      mwHttpJson<Record<string, unknown>>(`${adminUrl(h, topicRest(full))}/stats`, auth(h)).catch(() => ({}) as Record<string, unknown>),
      mwHttpJson<{ partitions?: number }>(`${adminUrl(h, topicRest(full))}/partitions`, auth(h)).catch(() => ({}) as { partitions?: number })
    ])
    const configs: Record<string, string> = {}
    if (meta.partitions !== undefined || (stats as Record<string, unknown>).partitions) {
      void stats
    }
    return {
      partitions: [{ count: Number((stats as Record<string, unknown>).partitions ?? meta.partitions ?? 1) }],
      configs
    }
  },

  async topicCreate(h, input: MwTopicCreateInput) {
    const full = fullTopic(h, input.name)
    if (input.partitions && input.partitions > 1) {
      await mwHttp(`${adminUrl(h, `${topicRest(full)}/partitions`)}`, { method: 'PUT', ...auth(h), body: JSON.stringify(Number(input.partitions)) })
    } else {
      await mwHttp(`${adminUrl(h, topicRest(full))}`, { method: 'PUT', ...auth(h) })
    }
  },

  async topicUpdate() {
    throw new Error('Pulsar topic 更新经 policies 接口逐项设置，暂不支持表单编辑')
  },

  async topicDelete(h, name) {
    const full = fullTopic(h, name)
    const partitioned = await mwHttpJson<{ partitions?: number }>(`${adminUrl(h, topicRest(full))}/partitions`, { ...auth(h), timeoutMs: 8000 }).then(() => true).catch(() => false)
    if (partitioned) await mwHttp(`${adminUrl(h, `${topicRest(full)}/partitions`)}`, { method: 'DELETE', ...auth(h), body: JSON.stringify(true) })
    else await mwHttp(`${adminUrl(h, topicRest(full))}`, { method: 'DELETE', ...auth(h), body: JSON.stringify(true) })
  },

  async topicPurge(h, name) {
    const full = fullTopic(h, name)
    await mwHttp(`${adminUrl(h, `${topicRest(full)}/all-cursors/reset`)}`, { method: 'POST', ...auth(h) })
  },

  async partitionsGrow(h, input) {
    const full = fullTopic(h, input.topic)
    await mwHttp(`${adminUrl(h, `${topicRest(full)}/partitions`)}`, { method: 'POST', ...auth(h), body: JSON.stringify(Number(input.count)) })
  },

  exchangesList: async () => unsupported('交换机管理'),
  exchangeCreate: async () => unsupported('交换机管理'),
  exchangeDelete: async () => unsupported('交换机管理'),
  bindingsList: async () => unsupported('绑定管理'),
  bindingCreate: async () => unsupported('绑定管理'),
  bindingDelete: async () => unsupported('绑定管理'),

  async groupsList(h, input) {
    // Pulsar 订阅依附于 topic：扫描 topics 的 subscriptions
    const topics = await this.topicsList(h, {})
    const out: MwConsumerGroup[] = []
    for (const topic of topics.slice(0, 100)) {
      const full = String(topic.extras?.fullTopic ?? fullTopic(h, topic.name))
      const stats = await mwHttpJson<PulsarTopicStats>(`${adminUrl(h, topicRest(full))}/stats`, { ...auth(h), timeoutMs: 8000 }).catch(() => ({}) as PulsarTopicStats)
      for (const [name, sub] of Object.entries(stats?.subscriptions ?? {})) {
        if (input.search && !name.toLowerCase().includes(input.search.toLowerCase())) continue
        const detail = sub as Record<string, unknown>
        out.push({
          groupId: name,
          state: String(detail['type'] ?? 'Exclusive'),
          members: Number(detail['consumers'] ?? detail['consumersAfterRedeliver'] ?? 0) || 0,
          totalLag: Number(detail['msgBacklog'] ?? 0),
          topics: [topic.name],
          extras: { topic: topic.name, fullTopic: full, activeConsumer: String(detail['activeConsumer'] ?? '') }
        })
      }
    }
    return out
  },

  async groupDescribe(h, groupId) {
    const subs = await this.groupsList(h, {})
    const mine = subs.filter(s => s.groupId === groupId)
    if (!mine.length) throw new Error(`订阅不存在：${groupId}`)
    const first = mine[0]
    const detail: MwConsumerGroupDetail = {
      groupId,
      state: first.state,
      members: mine.map(s => ({ clientId: String(s.extras?.activeConsumer || s.groupId), topics: [String(s.extras?.topic ?? '')] })),
      offsets: mine.map(s => ({
        topic: String(s.extras?.topic ?? ''),
        currentOffset: 'n/a',
        logEndOffset: 'n/a',
        lag: Number(s.totalLag ?? 0)
      }))
    }
    return detail
  },

  async groupResetOffsets(h, input) {
    const full = fullTopic(h, input.topic)
    const to = input.to === 'earliest' ? 'earliest' : input.to === 'latest' ? 'latest' : input.to === 'timestamp' ? `timestamp:${Number(input.timestamp ?? Date.now())}` : undefined
    if (!to) throw new Error('Pulsar 支持 earliest/latest/timestamp 重置（resetCursor）')
    await mwHttp(`${adminUrl(h, `subscription/${topicRest(full)}/${encodeURIComponent(input.groupId)}/resetcursor/${to}`)}`, { method: 'POST', ...auth(h) })
  },

  async clientsList(h) {
    // Pulsar REST 无运行时连接列表：以 broker 清单代偿
    const brokers = await mwHttpJson<Array<Record<string, string>>>(adminUrl(h, 'brokers'), auth(h)).catch(() => [] as Array<Record<string, string>>)
    return (brokers ?? []).map(b => ({
      clientId: String(b['brokerId'] ?? b['brokerUrl'] ?? ''),
      host: String(b['brokerUrl'] ?? ''),
      extras: { version: String(b['version'] ?? '') }
    }))
  },

  clientKick: async () => unsupported('断开连接'),

  async messagesQuery(h, input: MwMessageQueryInput) {
    // peek：exclusive consumer 读头几条后即关
    const full = fullTopic(h, input.topic)
    const count = Math.max(1, Math.min(Number(input.max) || 10, 50))
    const WS = await wsModule.get()
    const query = new URLSearchParams({ uri: full, subscriptionName: `enest-peek-${Date.now()}`, receiverQueueSize: String(count) })
    return new Promise<MwMessage[]>((resolve, reject) => {
      const socket = new WS(`${rt(h).base.replace(/^http/, 'ws')}/ws/consumer?${query.toString()}`, {
        headers: rt(h).token ? { authorization: `Bearer ${rt(h).token}` } : {}
      })
      const messages: MwMessage[] = []
      const timer = setTimeout(() => { socket.close(); resolve(messages) }, 8000)
      socket.once('error', error => { clearTimeout(timer); reject(error) })
      socket.on('message', (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString()) as { messageId?: string; payload?: string; properties?: Record<string, string>; publishTime?: number; context?: string }
          const ackMsg = { messageId: parsed.messageId, context: parsed.context }
          socket.send(JSON.stringify(ackMsg))
          messages.push(toMwMessage(input.topic, Buffer.from(parsed.payload ?? '', 'base64').toString('utf8'), parsed.properties, parsed.messageId?.slice(0, 24), parsed.publishTime))
          if (messages.length >= count) { clearTimeout(timer); socket.close(); resolve(messages) }
        } catch { /* 非 JSON 帧跳过 */ }
      })
      socket.once('close', () => { clearTimeout(timer); resolve(messages) })
    })
  },

  async messageGet(h, input) {
    if (!input.messageId) throw new Error('Pulsar 定位消息需 messageId（peek 头部）')
    const rows = await this.messagesQuery(h, { topic: input.topic, from: 'earliest', max: 50 })
    return rows.find(m => m.messageId === input.messageId) ?? null
  },

  async messageSend(h, input: MwMessageSendInput) {
    const r = rt(h)
    const socket = await r.producer?.get()
    if (!socket) throw new Error('Pulsar producer 未初始化')
    const full = fullTopic(h, input.topic)
    const request = {
      topic: full,
      payload: Buffer.from(input.payload, input.payloadEncoding === 'base64' ? 'base64' : 'utf8').toString('base64'),
      properties: input.headers ?? {},
      ...(input.key ? { key: input.key } : {}),
      ...(input.partition !== undefined ? { partition: input.partition } : {})
    }
    return new Promise<{ ok: boolean; detail?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Pulsar 发送超时（10s）')), 10000)
      const onMessage = (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString()) as { result?: string;errorMsg?: string; messageId?: string }
          if (parsed.result === 'ok') {
            clearTimeout(timer)
            socket.off('message', onMessage)
            resolve({ ok: true, detail: parsed.messageId ? `messageId ${String(parsed.messageId).slice(0, 24)}` : undefined })
          } else if (parsed.result === 'error') {
            clearTimeout(timer)
            socket.off('message', onMessage)
            reject(new Error(`Pulsar 发送失败：${parsed.errorMsg ?? '未知'}`))
          }
        } catch { /* 忽略非 JSON 帧 */ }
      }
      socket.once('message', onMessage)
      socket.send(JSON.stringify(request))
    })
  },

  async messageResend(h, input) {
    return this.messageSend(h, {
      topic: input.targetTopic ?? input.message.topic,
      payload: input.message.payload,
      key: input.message.key,
      headers: input.message.properties ?? input.message.headers
    })
  },

  async configsDescribe(h, input) {
    const full = fullTopic(h, input.topic)
    const policies = await mwHttpJson<Record<string, unknown>>(`${adminUrl(h, topicRest(full))}/policies`, auth(h)).catch(() => ({}) as Record<string, unknown>)
    return Object.entries(policies).map(([name, value]) => ({ name, value: JSON.stringify(value) }))
  },

  async configsAlter() {
    throw new Error('Pulsar policies 更新为结构化 JSON，暂不支持表单编辑')
  },

  traceMessage: async (): Promise<MwTrace> => unsupported('消息轨迹'),
  retainedList: async () => unsupported('retained 管理'),
  retainedDelete: async () => unsupported('retained 管理'),
  queueTemplate: async () => unsupported('死信/延迟模板'),

  async tailStart(h, input, sink) {
    const WS = await wsModule.get()
    const full = fullTopic(h, input.topic)
    const query = new URLSearchParams({ uri: full, subscriptionName: `enest-tail-${Date.now()}`, receiverQueueSize: '100' })
    const socket = new WS(`${rt(h).base.replace(/^http/, 'ws')}/ws/consumer?${query.toString()}`, {
      headers: rt(h).token ? { authorization: `Bearer ${rt(h).token}` } : {}
    })
    const signal = rt(h).signal
    socket.on('message', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString()) as { messageId?: string; payload?: string; properties?: Record<string, string>; publishTime?: number; context?: string }
        // ack 但不清 ack 语义（peek 型监听：自动 ack 防积压，不影响业务订阅）
        socket.send(JSON.stringify({ messageId: parsed.messageId, context: parsed.context }))
        const message = toMwMessage(input.topic, Buffer.from(parsed.payload ?? '', 'base64').toString('utf8'), parsed.properties, parsed.messageId?.slice(0, 24), parsed.publishTime)
        if (input.filter && !message.payload.includes(input.filter) && !message.topic.includes(input.filter)) return
        sink(message)
      } catch { /* 忽略非 JSON 帧 */ }
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Pulsar consumer WebSocket 握手超时')) }, 10000)
      socket.once('open', () => { clearTimeout(timer); resolve() })
      socket.once('error', error => { clearTimeout(timer); reject(error) })
    })
    if (signal.aborted) socket.close()
    return {
      stop: () => closeSocket(socket)
    }
  }
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === socket.CLOSED) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => socket.terminate(), 2000)
    socket.once('close', () => { clearTimeout(timer); resolve() })
    socket.close()
  })
}

export default pulsarDriver
