/** 中间件控制台（mw.*）工作台类型：连接配置、能力描述符、统一消息模型与 workbench action 契约。
 * 与 db-workbench.ts 同构：action 判别联合 + 每插件 UtilityProcess 内执行。 */

import type { MwConnectionField, MwListColumn, MwPageColumns, MwMetricSpec, MwSendField } from './mw-form'
export type { MwConnectionField, MwListColumn, MwPageColumns, MwMetricSpec, MwSendField } from './mw-form'

export type MwKind = string
export type MwFeatureState = 'available' | 'unsupported' | 'not-configured' | 'error'
export interface MwCapability {
  state: MwFeatureState
  reason?: string
}

/** EMQX 管理面适配（mqtt 连接的可选增强） */
export interface MwEmqxMgmt {
  enabled: boolean
  /** auto = 先探 v5(18083 /api/v5) 再探 v4(8081 /api/v4) */
  version: 'auto' | 'v4' | 'v5'
  apiUrl?: string
  apiKey?: string
  apiSecretRef?: string
  /** Resolved only inside the plugin backend; never returned to the renderer. */
  ephemeralSecret?: string
}

export interface MwConnectionConfig {
  kind: MwKind
  name?: string
  env?: 'dev' | 'test' | 'staging' | 'prod'
  /** 连接级只读：插件后端拦截全部变更类 action */
  readOnly?: boolean
  note?: string
  /** 凭据：插件后端通过所属 runtime 的 secret.resolve 获取，仅在后端保留。 */
  secretRef?: string
  ephemeralSecret?: string
  // —— kafka ——
  bootstrapServers?: string
  saslMechanism?: 'none' | 'plain' | 'scram-sha-256' | 'scram-sha-512' | 'oauthbearer'
  tls?: boolean
  tlsRejectUnauthorized?: boolean
  // —— rabbitmq ——
  managementUrl?: string
  vhost?: string
  username?: string
  // —— mqtt ——
  brokerUrl?: string
  clientId?: string
  emqx?: MwEmqxMgmt
  // —— rocketmq ——
  dashboardUrl?: string
  // —— activemq ——
  /** Jolokia 端点，如 http://127.0.0.1:8161/console/jolokia（Classic 内置 console） */
  jolokiaUrl?: string
  /** Artemis 无 console 时可指 native jolokia agent，如 http://127.0.0.1:8774/jolokia */
  brokerName?: string
  // —— pulsar ——
  /** Pulsar Web 服务地址，如 http://127.0.0.1:8080（REST /admin/v2 与 WS /ws 同源推导） */
  serviceUrl?: string
  /** JWT token（vault 托管） */
  /** 透传扩展（如 kafka clientId、mqtt keepalive 等） */
  options?: Record<string, unknown>
  settings?: Record<string, unknown>
}

export interface MwSessionInfo {
  sessionKey: string
  kind: MwKind
  label: string
  connectedAt: number
  readOnly: boolean
  /** 运行时探测后的能力覆盖（EMQX 探测 / dashboard 版本探测）；缺省用 kinds.list 静态描述符 */
  capabilities?: Record<string, MwCapability>
  messageQueryModes?: MwMessageQueryMode[]
}

export type MwMessageQueryMode = 'offset' | 'time' | 'key' | 'id'

export interface MwDriverDescriptor {
  kind: MwKind
  label: string
  transport: 'native' | 'http'
  defaultPort?: number
  /** 历史消息定位方式（UI 据此渲染过滤栏） */
  messageQueryModes: MwMessageQueryMode[]
  capabilities: Record<string, MwCapability>
  /** 连接表单字段（kind 专属；前端按声明渲染抽屉表单） */
  connectionFields: MwConnectionField[]
  /** 列表页列描述（topics 页按 kind 分段；rmq queues/exchanges/bindings 三段） */
  pageColumns?: MwPageColumns[]
  /** 概览/监控指标卡描述（label/unit 一次声明；运行时 metricSpecs 可覆盖） */
  metricsSpec?: MwMetricSpec[]
  /** 发消息页特有字段（topic/payload/headers 之外） */
  sendFields?: MwSendField[]
  ui?: MwDriverPresentation
  completionRules?: Array<Record<string, unknown>>
  settings?: Array<Record<string, unknown>>
  views?: unknown
}

export interface MwDriverPresentation {
  color?: string
  topicLabel?: string
  topicsModel?: 'topics' | 'queues' | 'subscriptions'
  groupsModel?: 'groups' | 'connections' | 'clients'
  topicForm?: 'partitioned' | 'queue-count'
  publishHeaders?: boolean
  publishModel?: 'direct' | 'queue-route'
  messageHint?: string
  groupsHint?: string
  authLabel?: string
  integrationBadge?: { field: string; label: string; missingLabel: string }
}

/** 统一消息信封：四类中间件的浏览/重发/监听共用 */
export interface MwMessage {
  messageId?: string
  topic: string
  /** kafka 分区；rocketmq 队列号；rmq/mqtt 无 */
  partition?: number
  offset?: number
  timestamp: number
  key?: string
  payload: string
  payloadEncoding?: 'utf8' | 'base64'
  payloadType?: 'json' | 'text' | 'binary'
  headers?: Record<string, string>
  properties?: Record<string, string>
  redelivered?: boolean
  payloadBytes?: number
  /** 各家特有字段（rocketmq 重试次数/出生地、rmq routing_key、mqtt retain/qos…） */
  extras?: Record<string, string | number | boolean>
}

/** Topic / 队列 / 交换机 / retained 统一列表项 */
export interface MwTopic {
  name: string
  /** 实体语义（UI 列头按 kind 翻译） */
  entity: 'topic' | 'queue' | 'exchange' | 'retained' | 'subscription'
  partitions?: number
  replicas?: number
  messageCount?: number
  consumerCount?: number
  durable?: boolean
  autoDelete?: boolean
  /** rmq exchange 类型 / rocketmq topic 类型（NORMAL/FIFO/DELAY/TRANSACTION） */
  type?: string
  internal?: boolean
  totalSizeBytes?: number
  lag?: number
  extras?: Record<string, string | number | boolean>
}

export interface MwConsumerGroup {
  groupId: string
  state?: string
  members?: number
  totalLag?: number
  topics?: string[]
  extras?: Record<string, string | number | boolean>
}

export interface MwConsumerGroupDetail {
  groupId: string
  state?: string
  members: Array<{ clientId: string; host?: string; topics?: string[] }>
  offsets: Array<{
    topic: string
    partition?: number
    currentOffset: string | number
    logEndOffset: string | number
    lag: number
  }>
}

export interface MwClient {
  clientId: string
  host?: string
  connectedAt?: number
  subscriptionsCount?: number
  extras?: Record<string, string | number | boolean>
}

export interface MwOverview {
  kind: MwKind
  clusterName?: string
  brokers: Array<{ id: string; host: string; roles?: string; alive?: boolean; extras?: Record<string, string | number | boolean> }>
  metrics: Record<string, string | number>
  /** 运行时指标描述覆盖（EMQX 探测前后/$SYS 动态键）；缺省用描述符 metricsSpec */
  metricSpecs?: MwMetricSpec[]
  notes?: string[]
}

export interface MwTraceStep {
  phase: 'produced' | 'stored' | 'consume-attempt'
  timestamp: number
  status: 'success' | 'failed' | 'unknown'
  /** producer 组 / broker 节点 / consumer 组 */
  actor: string
  detail?: Record<string, string>
  costMs?: number
}

export interface MwTrace {
  key: string
  messageId?: string
  steps: MwTraceStep[]
}

// —— 各 action 的输入类型 ——

export interface MwTopicCreateInput {
  name: string
  partitions?: number
  replicationFactor?: number
  configs?: Record<string, string>
  durable?: boolean
  autoDelete?: boolean
  /** rmq exchange type（direct/topic/fanout/headers）或 rocketmq 类型（NORMAL/FIFO/DELAY/TRANSACTION） */
  type?: string
  /** rocketmq 队列数 */
  queueNum?: number
  arguments?: Record<string, unknown>
}

export interface MwMessageQueryInput {
  topic: string
  partition?: number
  from: 'earliest' | 'latest' | 'offset' | 'timestamp' | 'key' | 'id'
  key?: string
  messageId?: string
  offset?: number
  timestamp?: number
  max?: number
  keyContains?: string
  /** quick 模式强制上限 200 */
  surface?: 'quick' | 'shell'
}

export interface MwMessageSendInput {
  topic: string
  payload: string
  payloadEncoding?: 'utf8' | 'base64'
  key?: string
  partition?: number
  headers?: Record<string, string>
  /** rmq 发布走交换机时 topic 填 exchange，此字段为 routing key */
  routingKey?: string
  properties?: Record<string, string>
  qos?: 0 | 1 | 2
  retain?: boolean
}

export interface MwGroupResetInput {
  groupId: string
  topic: string
  partition?: number
  to: 'earliest' | 'latest' | 'timestamp' | 'offset'
  timestamp?: number
  offset?: number
}

export interface MwBindingCreateInput {
  source: string
  destination: string
  /** destinationType 仅 rmq 生效 */
  destinationType?: 'queue' | 'exchange'
  routingKey?: string
  arguments?: Record<string, unknown>
}

/** rmq 死信/延迟队列模板输入 */
export interface MwQueueTemplateInput {
  template: 'dlq' | 'delay'
  /** 源队列名（dlq：为该队列配死信；delay：TTL+DLX 路线的延迟队列名） */
  queue: string
  /** 死信交换机名（dlq：默认 {queue}.dlx；delay：默认 delay.exchange） */
  exchange?: string
  /** 死信目标队列名（dlq：默认 {queue}.dlq） */
  dlq?: string
  routingKey?: string
  /** delay 模板：消息 TTL 毫秒数（进入死信队列前滞留时长） */
  ttlMs?: number
  /** delay 模板：x-delayed-message 插件路线（服务端需装 rabbitmq_delayed_message_exchange） */
  usePlugin?: boolean
  durable?: boolean
}

// —— workbench action 契约（权限映射见插件 backend/workbench.ts）——

export type MwWorkbenchRequest =
  // net.messaging
  | { action: 'kinds.list'; input?: Record<string, never> }
  | { action: 'test'; input: { config: MwConnectionConfig } }
  | { action: 'session.open'; input: { sessionKey: string; config: MwConnectionConfig } }
  | { action: 'session.close'; input: { sessionKey: string } }
  | { action: 'session.list'; input?: Record<string, never> }
  // net.messaging.read
  | { action: 'overview'; input: { sessionKey: string } }
  | { action: 'topics.list'; input: { sessionKey: string; search?: string; includeInternal?: boolean } }
  | { action: 'topic.describe'; input: { sessionKey: string; topic: string } }
  | { action: 'exchanges.list'; input: { sessionKey: string; search?: string } }
  | { action: 'bindings.list'; input: { sessionKey: string; source?: string; destination?: string } }
  | { action: 'groups.list'; input: { sessionKey: string; search?: string } }
  | { action: 'group.describe'; input: { sessionKey: string; groupId: string } }
  | { action: 'clients.list'; input: { sessionKey: string; search?: string } }
  | { action: 'messages.query'; input: MwMessageQueryInput & { sessionKey: string } }
  | { action: 'messages.get'; input: { sessionKey: string; topic: string; messageId?: string; partition?: number; offset?: number } }
  | { action: 'tail.start'; input: { sessionKey: string; tailId: string; topic: string; filter?: string } }
  | { action: 'tail.stop'; input: { sessionKey: string; tailId: string } }
  | { action: 'configs.describe'; input: { sessionKey: string; topic: string } }
  | { action: 'trace.message'; input: { sessionKey: string; key: string } }
  | { action: 'retained.list'; input: { sessionKey: string; search?: string } }
  // net.messaging.admin（连接级 readOnly 时插件后端直接拒绝）
  | { action: 'topic.create'; input: { sessionKey: string; topic: MwTopicCreateInput } }
  | { action: 'topic.update'; input: { sessionKey: string; name: string; attrs: Partial<MwTopicCreateInput> } }
  | { action: 'topic.delete'; input: { sessionKey: string; name: string } }
  | { action: 'topic.purge'; input: { sessionKey: string; name: string } }
  | { action: 'partitions.grow'; input: { sessionKey: string; topic: string; count: number } }
  | { action: 'exchange.create'; input: { sessionKey: string; exchange: { name: string; type: string; durable?: boolean; autoDelete?: boolean; arguments?: Record<string, unknown> } } }
  | { action: 'exchange.delete'; input: { sessionKey: string; name: string } }
  | { action: 'binding.create'; input: { sessionKey: string; binding: MwBindingCreateInput } }
  | { action: 'binding.delete'; input: { sessionKey: string; source: string; destination: string; propertiesKey: string } }
  | { action: 'group.resetOffsets'; input: { sessionKey: string } & MwGroupResetInput }
  | { action: 'client.kick'; input: { sessionKey: string; clientId: string } }
  | { action: 'messages.send'; input: MwMessageSendInput & { sessionKey: string } }
  | { action: 'messages.resend'; input: { sessionKey: string; message: MwMessage; targetTopic?: string } }
  | { action: 'configs.alter'; input: { sessionKey: string; topic: string; configs: Record<string, string> } }
  | { action: 'retained.delete'; input: { sessionKey: string; topic: string } }
  /** rmq 死信/延迟模板：一条龙建 DLX exchange + DLQ 队列 + 绑定（或延迟队列路线） */
  | { action: 'queue.template'; input: { sessionKey: string } & MwQueueTemplateInput }

/** 变更类 action 集合（连接 readOnly 时插件后端拒绝；与权限映射保持同步） */
export const MW_MUTATING_ACTIONS: readonly string[] = [
  'topic.create', 'topic.update', 'topic.delete', 'topic.purge', 'partitions.grow',
  'exchange.create', 'exchange.delete', 'binding.create', 'binding.delete',
  'group.resetOffsets', 'client.kick', 'messages.send', 'messages.resend',
  'configs.alter', 'retained.delete', 'queue.template'
]

/** Connection probe result shared by renderer declarations and utility drivers. */
export interface MwTestResult { ok: boolean; message: string; latencyMs: number }
