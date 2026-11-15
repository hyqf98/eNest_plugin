/** Redis 驱动（ioredis）：Streams（XADD/XRANGE/XREADGROUP/XINFO）+ Pub/Sub（PUBLISH/SUBSCRIBE）双模式。
 * redisMode=streams 时 topic=stream key；pubsub 时 topic=channel。
 * 消费组 = XGROUP；offset 重置 = XGROUP SETID；清空 = XTRIM MAXLEN 0。 */
import type Redis from 'ioredis'
import type {
  MwClient,
  MwConnectionConfig,
  MwConnectionField,
  MwConsumerGroup,
  MwConsumerGroupDetail,
  MwMessage,
  MwMessageQueryInput,
  MwMessageSendInput,
  MwMetricSpec,
  MwOverview,
  MwPageColumns,
  MwSendField,
  MwTopic,
  MwTrace,
  MwBindingCreateInput,
  MwTopicCreateInput
} from '@backend/contracts/mw-workbench'
import type { MwDriver, MwDriverContext, MwDriverHandle, MwTestResult } from '@backend/types'
import { unsupported } from '@backend/types'
import { createLazyResource, type LazyResource } from '@backend/lazyResource'

const ioredisModule = createLazyResource(() => import('ioredis').then(module => module.default))

const CAPS: Record<string, { state: 'available' | 'unsupported'; reason?: string }> = {
  topicCrud: { state: 'available', reason: 'streams 模式：创建/删除 stream key；pubsub 模式仅通道列表' },
  partitions: { state: 'unsupported', reason: 'Redis Stream 无分区概念' },
  exchanges: { state: 'unsupported', reason: 'Redis 无交换机概念' },
  bindings: { state: 'unsupported', reason: 'Redis 无绑定概念' },
  consumerGroups: { state: 'available', reason: 'streams 模式：XGROUP 消费组' },
  offsetReset: { state: 'available', reason: 'XGROUP SETID（重置消费位点）' },
  clients: { state: 'available', reason: 'CLIENT LIST（连接列表）' },
  clientKick: { state: 'available', reason: 'CLIENT KILL ID' },
  messageQuery: { state: 'available', reason: 'XRANGE/XREVRANGE 按 ID 区间；ID 含毫秒时间戳可按时间定位' },
  tail: { state: 'available', reason: 'streams：XREAD BLOCK；pubsub：SUBSCRIBE' },
  publish: { state: 'available', reason: 'streams：XADD；pubsub：PUBLISH' },
  resend: { state: 'available' },
  trace: { state: 'unsupported', reason: 'Redis 无消息轨迹' },
  retained: { state: 'unsupported', reason: 'Redis 无 retained 概念' },
  configMgmt: { state: 'unsupported', reason: 'Stream 无配置面' },
  monitor: { state: 'available', reason: 'INFO memory/clients/stats' },
  dlqBrowse: { state: 'unsupported', reason: 'Redis Streams 无死信队列（需业务侧 PEL 处理）' }
}

const CONNECTION_FIELDS: MwConnectionField[] = [
  { key: 'redisUrl', label: '地址', type: 'text', required: true, pattern: 'redis-url', placeholder: '127.0.0.1:6379 或 redis:// user:pass@host:6379', tip: 'host:port、redis://、rediss://（TLS）、sentinel:// 均可' },
  { key: 'secret', label: '密码（URL 未含时）', type: 'password', vaultSlot: 'primary', half: true },
  { key: 'redisDb', label: 'DB 编号', type: 'number', default: 0, min: 0, half: true },
  { key: 'redisMode', label: '浏览模式', type: 'select', default: 'streams', options: [
    { value: 'streams', label: 'Streams（队列语义）' },
    { value: 'pubsub', label: 'Pub/Sub（通道语义）' }
  ], tip: 'streams=消息留存可回溯；pubsub=即发即失仅实时监听' }
]

const PAGE_COLUMNS: MwPageColumns[] = [
  { page: 'topics', columns: [
    { key: 'name', title: 'STREAM / CHANNEL', format: 'mono', width: '34%' },
    { key: 'type', title: '类型', format: 'chip' },
    { key: 'messageCount', title: '消息数', format: 'compact' },
    { key: 'consumerCount', title: '消费组', format: 'num' },
    { key: 'totalSizeBytes', title: '内存占用', format: 'bytes' },
    { key: 'lag', title: '组内堆积', format: 'lag' }
  ] },
  { page: 'groups', columns: [
    { key: 'groupId', title: '消费组', format: 'mono', width: '28%' },
    { key: 'state', title: '状态', format: 'chip' },
    { key: 'members', title: '消费者', format: 'num' },
    { key: 'totalLag', title: '总堆积', format: 'lag' },
    { key: 'lastId', title: '位点', format: 'mono', from: 'extras' }
  ] },
  { page: 'clients', columns: [
    { key: 'clientId', title: '连接 ID', format: 'mono', width: '22%' },
    { key: 'host', title: '来源地址', format: 'mono' },
    { key: 'connectedAt', title: '空闲', format: 'ms', from: 'extras' },
    { key: 'subscriptionsCount', title: '订阅', format: 'num' }
  ] }
]

const METRICS_SPEC: MwMetricSpec[] = [
  { key: 'version', label: '版本', unit: 'text' },
  { key: 'usedMemory', label: '内存占用', unit: 'bytes' },
  { key: 'maxmemory', label: '内存上限', unit: 'bytes' },
  { key: 'connectedClients', label: '客户端连接', unit: 'count' },
  { key: 'opsPerSec', label: 'OPS/s', unit: 'rate' },
  { key: 'streams', label: 'Stream 数', unit: 'count' },
  { key: 'pubsubChannels', label: 'Pub/Sub 通道', unit: 'count' },
  { key: 'uptime', label: '运行时长', unit: 'ms' }
]

const SEND_FIELDS: MwSendField[] = [
  { key: 'key', label: '字段前缀（可选）', type: 'text', placeholder: '缺省 data；XADD 为 {key}: {payload}', half: true },
  { key: 'ttlMs', label: 'XTRIM 近似上限（可选）', type: 'number', placeholder: '如 100000：写入后按近似长度裁剪', min: 0, half: true }
]

interface RedisRuntime {
  mode: 'streams' | 'pubsub'
  client: LazyResource<Redis>
  signal: AbortSignal
  /** XREAD BLOCK 专用连接（阻塞命令独占） */
  blockedClient?: LazyResource<Redis>
}

function rt(h: MwDriverHandle): RedisRuntime {
  return h.runtime as unknown as RedisRuntime
}

/** 组装 ioredis 连接参数（host:port 或 URL 均可） */
async function createClient(config: MwConnectionConfig, password?: string): Promise<Redis> {
  const RedisCtor = await ioredisModule.get()
  const raw = (config.redisUrl ?? '').trim()
  const db = Number(config.redisDb ?? 0)
  if (/^[^:]+:\d+$/.test(raw)) {
    const [host, port] = raw.split(':')
    return new RedisCtor({ host, port: Number(port), password, db, lazyConnect: false, maxRetriesPerRequest: 1, connectTimeout: 8000 })
  }
  // URL 形态：密码经 URL 或独立 password 参数均可
  let url = raw || 'redis://127.0.0.1:6379'
  if (!/^rediss?:\/\/|^sentinel:\/\//.test(url)) url = `redis://${url}`
  const instance = new RedisCtor(url, { password, db, lazyConnect: false, maxRetriesPerRequest: 1, connectTimeout: 8000 })
  return instance
}

function streamIdToMs(id: string): number {
  const ms = Number(id.split('-')[0])
  return Number.isFinite(ms) ? ms : 0
}

function entryToMessage(stream: string, id: string, fields: Record<string, string>): MwMessage {
  const payload = fields['data'] ?? fields['payload'] ?? fields['value'] ?? JSON.stringify(fields)
  return {
    messageId: id,
    topic: stream,
    offset: Number(id.split('-')[1] ?? 0),
    timestamp: streamIdToMs(id),
    key: fields['key'],
    payload,
    payloadType: payload.trim().startsWith('{') || payload.trim().startsWith('[') ? 'json' : 'text',
    payloadBytes: Buffer.byteLength(payload),
    extras: { streamId: id, mode: 'xrange' }
  }
}

export const redisDriver: MwDriver = {
  kind: 'redis',
  label: 'Redis',
  transport: 'native',
  defaultPort: 6379,
  capabilities: CAPS,
  messageQueryModes: ['time'],
  connectionFields: CONNECTION_FIELDS,
  pageColumns: PAGE_COLUMNS,
  metricsSpec: METRICS_SPEC,
  sendFields: SEND_FIELDS,

  async test(config, password) {
    const started = Date.now()
    let client: Redis | undefined
    try {
      client = await createClient(config, password)
      const pong = await client.ping()
      if (pong !== 'PONG') throw new Error(`PING 响应异常：${pong}`)
      return { ok: true, message: '已连接 Redis', latencyMs: Date.now() - started }
    } catch (error) {
      return { ok: false, message: `Redis 连接失败：${(error as Error).message}`, latencyMs: Date.now() - started }
    } finally {
      client?.disconnect()
    }
  },

  async open(config, password, ctx) {
    ctx.signal.throwIfAborted()
    const mode = config.redisMode === 'pubsub' ? 'pubsub' : 'streams'
    const client = createLazyResource(() => createClient(config, password), instance => instance.disconnect())
    const probe = await client.get()
    ctx.signal.throwIfAborted()
    await probe.ping()
    const runtime: RedisRuntime = { mode, client, signal: ctx.signal }
    return {
      kind: 'redis', raw: null, config, readOnly: false, password,
      capabilities: { ...CAPS }, messageQueryModes: ['time'],
      runtime: runtime as unknown as Record<string, unknown>
    }
  },

  async close(h) {
    const r = rt(h)
    h.closed = true
    await Promise.allSettled([r.client.close(), r.blockedClient?.close()]).then(() => undefined)
  },

  async overview(h) {
    const client = await rt(h).client.get()
    const info = await client.info()
    const parsed = parseInfo(info)
    const [dbsize, channels] = await Promise.all([
      client.dbsize().catch(() => 0),
      rt(h).mode === 'pubsub' ? client.pubsub('CHANNELS').catch(() => [] as string[]) : Promise.resolve([] as string[])
    ])
    let streams = 0
    if (rt(h).mode === 'streams') {
      try {
        const keys = await client.keys('*')
        if (keys.length) {
          const types = await Promise.all(keys.slice(0, 200).map(k => client.type(k)))
          streams = types.filter(t => t === 'stream').length
        }
      } catch { /* 探测失败置 0 */ }
    }
    return {
      kind: 'redis',
      clusterName: parsed.redis_mode === 'cluster' ? 'cluster' : (parsed.redis_version ? `standalone ${parsed.redis_version}` : undefined),
      brokers: [{ id: 'redis', host: String((h.config.redisUrl ?? '').slice(0, 60)), roles: parsed.redis_mode ?? 'standalone', alive: true }],
      metrics: {
        version: String(parsed.redis_version ?? '—'),
        usedMemory: Number(parsed.used_memory ?? 0),
        maxmemory: Number(parsed.maxmemory ?? 0),
        connectedClients: Number(parsed.connected_clients ?? 0),
        opsPerSec: Number(parsed.instantaneous_ops_per_sec ?? 0),
        streams,
        pubsubChannels: channels.length,
        uptime: Number(parsed.uptime_in_seconds ?? 0) * 1000,
        keyCount: dbsize
      },
      notes: ['Stream 数经 SCAN/type 采样（≤200 key）；生产大库建议限制 scan 或直接用 stream 名单']
    } as MwOverview
  },

  async topicsList(h, input) {
    const r = rt(h)
    const client = await r.client.get()
    if (r.mode === 'pubsub') {
      const channels = await (client.pubsub as (subcommand: string, pattern?: string) => Promise<string[]>)('CHANNELS', input.search ? `${input.search}*` : undefined)
      return channels.map(name => ({
        name,
        entity: 'subscription' as const,
        type: 'channel',
        extras: { mode: 'pubsub' }
      }))
    }
    // streams 模式：SCAN type stream
    const out: MwTopic[] = []
    let cursor = '0'
    do {
      const result = await (client.scan as unknown as (cursor: string, ...args: string[]) => Promise<[string, string[]]>)(cursor, 'MATCH', input.search ? `*${input.search}*` : '*', 'TYPE', 'stream', 'COUNT', '200')
      cursor = result[0]
      for (const key of result[1]) {
        const [length, groups] = await Promise.all([
          client.xlen(key).catch(() => 0),
          client.xinfo('GROUPS', key).catch(() => [] as unknown[])
        ])
        let lag = 0
        for (const g of groups as Array<Record<string, unknown>>) lag += Number(g['lag'] ?? 0)
        out.push({
          name: key,
          entity: 'topic' as const,
          type: 'stream',
          messageCount: Number(length ?? 0),
          consumerCount: (groups as unknown[]).length,
          lag,
          extras: { mode: 'streams' }
        })
      }
    } while (cursor !== '0' && out.length < 500)
    return out.sort((a, b) => a.name.localeCompare(b.name))
  },

  async topicDescribe(h, topic) {
    const client = await rt(h).client.get()
    const info = await client.xinfo('STREAM', topic) as unknown[]
    const pairs: Record<string, string> = {}
    for (let i = 0; i < info.length - 1; i += 2) pairs[String(info[i])] = String(info[i + 1])
    return { configs: pairs }
  },

  async topicCreate(h, input: MwTopicCreateInput) {
    const client = await rt(h).client.get()
    // XGROUP CREATE 需要流存在：MKSTREAM 一并建
    await client.xgroup('CREATE', input.name, 'enest-init', '0', 'MKSTREAM').catch(error => {
      if (!String(error).includes('BUSYGROUP')) throw error
    })
    // 初始组仅作建流载体，随即删除，保留空流
    await client.xgroup('DESTROY', input.name, 'enest-init').catch(() => undefined)
  },

  async topicUpdate() {
    throw new Error('Redis Stream 无可编辑属性')
  },

  async topicDelete(h, name) {
    const client = await rt(h).client.get()
    await client.del(name)
  },

  async topicPurge(h, name) {
    const client = await rt(h).client.get()
    await client.xtrim(name, 'MAXLEN', 0)
  },

  partitionsGrow: async () => unsupported('分区管理'),

  exchangesList: async () => unsupported('交换机管理'),
  exchangeCreate: async () => unsupported('交换机管理'),
  exchangeDelete: async () => unsupported('交换机管理'),
  bindingsList: async () => unsupported('绑定管理'),
  bindingCreate: async () => unsupported('绑定管理'),
  bindingDelete: async () => unsupported('绑定管理'),

  async groupsList(h, input) {
    const client = await rt(h).client.get()
    const keys = await scanStreams(client, input.search)
    const out: MwConsumerGroup[] = []
    for (const key of keys.slice(0, 50)) {
      const groups = await client.xinfo('GROUPS', key).catch(() => [] as unknown[])
      for (const g of groups as Array<Record<string, unknown>>) {
        const name = String(g['name'] ?? '')
        if (!name) continue
        out.push({
          groupId: name,
          state: Number(g['consumers'] ?? 0) > 0 ? 'running' : 'empty',
          members: Number(g['consumers'] ?? 0),
          totalLag: Number(g['lag'] ?? 0),
          topics: [key],
          extras: { stream: key, lastId: String(g['last-delivered-id'] ?? ''), pending: Number(g['pending'] ?? 0) }
        })
      }
    }
    return out
  },

  async groupDescribe(h, groupId) {
    const client = await rt(h).client.get()
    const keys = await scanStreams(client)
    for (const key of keys.slice(0, 100)) {
      const groups = await client.xinfo('GROUPS', key).catch(() => [] as unknown[])
      const mine = (groups as Array<Record<string, unknown>>).find(g => String(g['name'] ?? '') === groupId)
      if (!mine) continue
      const consumers = await client.xinfo('CONSUMERS', key, groupId).catch(() => [] as unknown[])
      const length = await client.xlen(key).catch(() => 0)
      const detail: MwConsumerGroupDetail = {
        groupId,
        state: Number(mine['consumers'] ?? 0) > 0 ? 'running' : 'empty',
        members: (consumers as Array<Record<string, unknown>>).map(c => ({
          clientId: String(c['name'] ?? ''),
          topics: [key]
        })),
        offsets: [{
          topic: key,
          currentOffset: String(mine['last-delivered-id'] ?? '0-0'),
          logEndOffset: Number(length),
          lag: Number(mine['lag'] ?? 0)
        }]
      }
      return detail
    }
    throw new Error(`消费组不存在：${groupId}（组依附于 stream，已扫描前 100 个 stream）`)
  },

  async groupResetOffsets(h, input) {
    const client = await rt(h).client.get()
    const id = input.to === 'earliest' ? '0'
      : input.to === 'latest' ? '$'
      : input.to === 'timestamp' ? `${Number(input.timestamp ?? Date.now())}-0`
      : undefined
    if (!id) throw new Error('Redis 仅支持 earliest/latest/timestamp 重置（XGROUP SETID）')
    await client.xgroup('SETID', input.topic, input.groupId, id)
  },

  async clientsList(h, input) {
    const client = await rt(h).client.get()
    const list = await client.client('LIST')
    const out: MwClient[] = []
    for (const line of String(list).split('\n')) {
      if (!line.trim()) continue
      const fields: Record<string, string> = {}
      for (const pair of line.split(' ')) {
        const idx = pair.indexOf('=')
        if (idx > 0) fields[pair.slice(0, idx)] = pair.slice(idx + 1)
      }
      const id = fields['id'] ?? ''
      if (!id) continue
      if (input.search && !(`${id} ${fields['addr'] ?? ''} ${fields['name'] ?? ''}`.toLowerCase().includes(input.search.toLowerCase()))) continue
      out.push({
        clientId: id,
        host: fields['addr'] ?? '',
        extras: { idle: Number(fields['idle'] ?? 0) * 1000, name: fields['name'] ?? '', db: fields['db'] ?? '' }
      })
    }
    return out.slice(0, 200)
  },

  async clientKick(h, clientId) {
    const client = await rt(h).client.get()
    await client.client('KILL', 'ID', clientId)
  },

  async messagesQuery(h, input: MwMessageQueryInput) {
    const client = await rt(h).client.get()
    const max = Math.max(1, Math.min(Number(input.max) || 10, 200))
    let start = '-', end = '+'
    if (input.from === 'timestamp' && input.timestamp) start = `${Number(input.timestamp)}-0`
    if (input.from === 'offset' && input.offset !== undefined) start = `${input.offset}`
    if (input.from === 'id' && input.messageId) start = `(${input.messageId}`
    const raw = await client.xrange(input.topic, start, end, 'COUNT', max)
    return raw.map(([id, fields]) => {
      const record: Record<string, string> = {}
      for (let i = 0; i < fields.length - 1; i += 2) record[fields[i]] = fields[i + 1]
      return entryToMessage(input.topic, id, record)
    })
  },

  async messageGet(h, input) {
    if (!input.messageId) throw new Error('Redis 定位消息需 stream ID（messageId）')
    const client = await rt(h).client.get()
    const raw = await client.xrange(input.topic, input.messageId, input.messageId, 'COUNT', 1)
    if (!raw.length) return null
    const [id, fields] = raw[0]
    const record: Record<string, string> = {}
    for (let i = 0; i < fields.length - 1; i += 2) record[fields[i]] = fields[i + 1]
    return entryToMessage(input.topic, id, record)
  },

  async messageSend(h, input: MwMessageSendInput) {
    const r = rt(h)
    const client = await r.client.get()
    if (r.mode === 'pubsub') {
      const count = await client.publish(input.topic, input.payload)
      return { ok: true, detail: `已发布到 ${count} 个订阅者` }
    }
    const field = input.key || 'data'
    const id = await client.xadd(input.topic, '*', field, input.payload)
    const trim = Number((input as MwMessageSendInput & { ttlMs?: number }).ttlMs)
    if (Number.isFinite(trim) && trim > 0) await client.xtrim(input.topic, 'MAXLEN', '~', trim).catch(() => undefined)
    return { ok: true, detail: `ID ${id}` }
  },

  async messageResend(h, input) {
    return this.messageSend(h, {
      topic: input.targetTopic ?? input.message.topic,
      payload: input.message.payload,
      key: input.message.key ?? 'data'
    })
  },

  async configsDescribe(h, input) {
    const detail = await this.topicDescribe(h, input.topic)
    return Object.entries(detail.configs ?? {}).map(([name, value]) => ({ name, value: String(value) }))
  },

  async configsAlter() {
    throw new Error('Redis Stream 配置只读')
  },

  traceMessage: async (): Promise<MwTrace> => unsupported('消息轨迹'),
  retainedList: async () => unsupported('retained 管理'),
  retainedDelete: async () => unsupported('retained 管理'),
  queueTemplate: async () => unsupported('死信/延迟模板'),

  async tailStart(h, input, sink) {
    const r = rt(h)
    const client = await r.client.get()
    if (r.mode === 'pubsub') {
      await client.subscribe(input.topic)
      const handler = (channel: string, message: string) => {
        if (channel !== input.topic) return
        if (input.filter && !message.includes(input.filter)) return
        sink({
          topic: channel,
          timestamp: Date.now(),
          payload: message,
          payloadType: message.trim().startsWith('{') ? 'json' : 'text',
          extras: { mode: 'subscribe' }
        })
      }
      client.on('message', handler)
      return {
        stop: async () => {
          client.off('message', handler)
          await client.unsubscribe(input.topic).catch(() => undefined)
        }
      }
    }
    // streams：XREAD BLOCK 轮询（0 起，从头监听需先读历史）
    let lastId = input.filter && /^\d+-\d+$/.test(input.filter) ? input.filter : '$'
    let stopped = false
    const loop = async () => {
      while (!stopped && !r.signal.aborted) {
        try {
          const result = await client.xread('BLOCK', 2000, 'STREAMS', input.topic, lastId)
          if (stopped || r.signal.aborted) return
          if (result && result.length) {
            for (const [stream, entries] of result) {
              for (const [id, fields] of entries) {
                lastId = id
                const record: Record<string, string> = {}
                for (let i = 0; i < fields.length - 1; i += 2) record[fields[i]] = fields[i + 1]
                const message = entryToMessage(stream, id, record)
                if (input.filter && !/^\d/.test(input.filter) && !message.payload.includes(input.filter)) continue
                sink(message)
              }
            }
          }
        } catch {
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
      }
    }
    void loop()
    return {
      stop: async () => { stopped = true }
    }
  }
}

async function scanStreams(client: Redis, search?: string): Promise<string[]> {
  const out: string[] = []
  let cursor = '0'
  do {
    const result = await (client.scan as unknown as (cursor: string, ...args: string[]) => Promise<[string, string[]]>)(cursor, 'MATCH', search ? `*${search}*` : '*', 'TYPE', 'stream', 'COUNT', '100')
    cursor = result[0]
    out.push(...result[1])
  } while (cursor !== '0' && out.length < 500)
  return out
}

function parseInfo(info: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of info.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}
