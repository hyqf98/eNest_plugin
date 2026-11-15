/**
 * kinds.js — 前端 kind 注册表镜像（单一事实来源的客户端缓存）
 * - 描述符真身在插件后端 MW_DRIVER_REGISTRY（kinds.list 下发），此处只缓存与派生
 * - 视觉映射（label/color/port）仅承载观感，不承载逻辑；逻辑全部走描述符
 * - 同步场景（树渲染/store 过滤/toMwConfig）用 descriptorOf()；未加载时回落静态表
 */
import api, { bindKindsBridge } from './api.js'

// 注册表模块自绑定（api.js 的 toMwConfig 依赖这里的 connectionFieldsOf）
bindKindsBridge({ connectionFieldsOf })

/** 静态兜底：后端不可达时的最小可视集合（与后端注册表同序） */
const FALLBACK = [
  { kind: 'kafka', label: 'Kafka', transport: 'native', defaultPort: 9092, messageQueryModes: ['offset', 'time', 'key'], capabilities: {}, connectionFields: [] },
  { kind: 'rabbitmq', label: 'RabbitMQ', transport: 'http', defaultPort: 15672, messageQueryModes: [], capabilities: {}, connectionFields: [] },
  { kind: 'mqtt', label: 'MQTT', transport: 'native', defaultPort: 1883, messageQueryModes: [], capabilities: {}, connectionFields: [] },
  { kind: 'rocketmq', label: 'RocketMQ', transport: 'http', defaultPort: 8080, messageQueryModes: ['time', 'key', 'id'], capabilities: {}, connectionFields: [] },
  { kind: 'activemq', label: 'ActiveMQ / Artemis', transport: 'http', defaultPort: 8161, messageQueryModes: [], capabilities: {}, connectionFields: [] },
  { kind: 'redis', label: 'Redis', transport: 'native', defaultPort: 6379, messageQueryModes: ['time'], capabilities: {}, connectionFields: [] },
  { kind: 'pulsar', label: 'Apache Pulsar', transport: 'http', defaultPort: 8080, messageQueryModes: [], capabilities: {}, connectionFields: [] }
]

/** 各 kind 的 dot 颜色（CSS 变量，纸感主题会覆盖） */
const KIND_COLORS = {
  kafka: 'var(--c-kafka)', rabbitmq: 'var(--c-rabbit)', mqtt: 'var(--c-mqtt)', rocketmq: 'var(--c-rocket)',
  activemq: 'var(--c-activemq)', redis: 'var(--c-redis)', pulsar: 'var(--c-pulsar)'
}

/** 消息页目标称谓（kind 语义差异，前端文案层） */
export const TOPIC_LABELS = {
  kafka: 'Topic', rabbitmq: '队列', mqtt: 'Topic', rocketmq: 'Topic',
  activemq: '目的地', redis: 'Stream', pulsar: 'Topic'
}

let cache = null // kinds.list 结果（含描述符）
let loading = null

/** 启动时加载一次（api.kinds 有自己的缓存，这里再镜像一份同步可用） */
export function initKinds() {
  if (!loading) {
    loading = api.kinds().then(list => { cache = Array.isArray(list) ? list : null }).catch(() => { cache = null })
  }
  return loading
}

/** 全部 kind 描述符（同步；未加载完成时回落静态表） */
export function kindList() {
  return cache && cache.length ? cache : FALLBACK
}

/** kind → 描述符（同步；缺省回落静态项） */
export function descriptorOf(kind) {
  return (cache?.find(d => d.kind === kind)) || FALLBACK.find(d => d.kind === kind) || null
}

/** 连接表单字段（同步；描述符缺失返回 []，表单退化为通用 name/env） */
export function connectionFieldsOf(kind) {
  return descriptorOf(kind)?.connectionFields ?? []
}

/** 列表列声明 */
export function pageColumnsOf(kind, page) {
  return descriptorOf(kind)?.pageColumns?.find(p => p.page === page)?.columns ?? null
}

/** 指标卡声明 */
export function metricsSpecOf(kind) {
  return descriptorOf(kind)?.metricsSpec ?? null
}

/** 发送字段声明 */
export function sendFieldsOf(kind) {
  return descriptorOf(kind)?.sendFields ?? []
}

/** 视觉 label（树/Tab/宫格） */
export function kindLabel(kind) {
  return descriptorOf(kind)?.label ?? kind
}

/** 视觉颜色 */
export function kindColor(kind) {
  return KIND_COLORS[kind] ?? 'var(--text-3)'
}

export function kindDot(kind) {
  return `<span class="kind-dot" style="background:${kindColor(kind)}"></span>`
}
