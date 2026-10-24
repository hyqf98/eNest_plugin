import { randomUUID } from 'node:crypto'
/**
 * mwService — utility process only; no Electron main APIs.
 * 中间件（kafka / rabbitmq / mqtt / rocketmq）插件会话服务
 * 职责：按 sessionKey 管理 open 会话与 tail 实时监听；分发 mw.* workbench action。
 * 连接配置保存在插件 KV；本后端拥有连接、只读策略和监听，宿主只提供通用控制能力。
 * 密钥经所属插件的 generic secret.resolve 获取，不回传渲染层。
 */
import type {
  MwConnectionConfig,
  MwSessionInfo,
  MwTestResult,
  MwWorkbenchRequest,
  MwDriverDescriptor
} from '@backend/contracts/mw-workbench'
import { MW_MUTATING_ACTIONS } from '@backend/contracts/mw-workbench'
import type { MwDriver, MwDriverContext, MwDriverHandle } from '@backend/types'

export interface MiddlewareRuntime {
  getDriver(kind: string): MwDriver
  descriptors(): MwDriverDescriptor[]
  emit(event: 'mw.data' | 'mw.error', payload: Record<string, unknown>): void
  acquire(token: string, reason: string): Promise<void>
  release(token: string): Promise<void>
}

export interface MwSession {
  sessionKey: string
  pluginId: string
  driver: MwDriver
  handle: MwDriverHandle
  controller: AbortController
  /** 进行中的实时监听：tailId → stop 句柄 */
  tails: Map<string, () => Promise<void>>
  startingTails: Map<string, Promise<void>>
  connectedAt: number
  token: string
  closing?: Promise<void>
}

export function createMiddlewareService(runtime: MiddlewareRuntime) {
const sessions = new Map<string, MwSession>()
const opening = new Map<string, { pluginId: string; token: string; controller: AbortController; promise: Promise<MwSessionInfo> }>()
const failedClosures = new Set<string>()
let stopped = false

/** Only the worker can emit the generic backend.event envelope. */
function postEvent(pluginId: string, event: 'mw.data' | 'mw.error', payload: Record<string, unknown>): void {
  if (stopped) return
  void pluginId
  runtime.emit(event, payload)
}

function requireSession(pluginId: string, sessionKey: string): MwSession {
  const s = sessions.get(sessionKey)
  if (!s || s.closing || s.handle.closed || stopped) throw new Error(`mw session not found or closed: ${sessionKey}; reconnect`)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  return s
}

function toSessionInfo(s: MwSession): MwSessionInfo {
  return {
    sessionKey: s.sessionKey,
    kind: s.handle.kind,
    label: s.handle.config.name || `${s.handle.kind}:${s.sessionKey}`,
    connectedAt: s.connectedAt,
    readOnly: !!s.handle.readOnly,
    capabilities: s.handle.capabilities,
    messageQueryModes: s.handle.messageQueryModes
  }
}

async function mwTest(pluginId: string, config: MwConnectionConfig): Promise<MwTestResult> {
  void pluginId
  if (stopped) throw new Error('middleware service is closing')
  const driver = runtime.getDriver(config.kind)
  return driver.test(config, config.ephemeralSecret)
}

function mwOpen(
  pluginId: string,
  input: { sessionKey: string; config: MwConnectionConfig }
): Promise<MwSessionInfo> {
  const sessionKey = input?.sessionKey
  const config = input?.config
  if (!sessionKey || typeof sessionKey !== 'string') throw new Error('sessionKey required')
  if (!config?.kind) throw new Error('config.kind required')
  if (stopped) throw new Error('middleware service is closing')
  if (opening.has(sessionKey)) throw new Error('middleware connection is already opening')
  if (sessions.size + opening.size >= 32) throw new Error('middleware connection limit reached')
  const driver = runtime.getDriver(config.kind)
  const previous = sessions.get(sessionKey)
  if (previous && previous.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  const controller = new AbortController()
  const token = randomUUID()
  const promise = (async () => {
    let retained = false
    try {
      await runtime.acquire(token, `mw:connection:${sessionKey}`)
      if (stopped) throw new Error('middleware service is closing')
      controller.signal.throwIfAborted()
      if (previous) await closeSession(previous)
      controller.signal.throwIfAborted()
      const ctx: MwDriverContext = {
        emit: (event, payload) => { if (!controller.signal.aborted && !sessions.get(sessionKey)?.closing) postEvent(pluginId, event === 'data' ? 'mw.data' : 'mw.error', { ...payload, sessionKey }) },
        signal: controller.signal
      }
      const handle = await driver.open(config, config.ephemeralSecret, ctx)
      if (stopped || controller.signal.aborted) {
        try { await driver.close(handle) }
        catch (error) { failedClosures.add(token); throw error }
        throw new Error('middleware connection closed during open')
      }
      handle.readOnly = config.readOnly === true
      const session: MwSession = { sessionKey, pluginId, driver, handle, controller, token, connectedAt: Date.now(), tails: new Map(), startingTails: new Map() }
      sessions.set(sessionKey, session)
      retained = true
      return toSessionInfo(session)
    } finally {
      try { if (!retained) { controller.abort(new Error('middleware open ended')); if (!failedClosures.has(token)) await runtime.release(token) } }
      finally { opening.delete(sessionKey) }
    }
  })()
  opening.set(sessionKey, { pluginId, token, controller, promise })
  return promise
}

/** 停掉全部 tail 后关闭驱动连接 */
async function closeSession(s: MwSession): Promise<void> {
  if (s.closing) return s.closing
  s.closing = (async () => {
    const starts = [...s.startingTails.values()]
    await Promise.allSettled(starts)
    const tails = await Promise.allSettled([...s.tails.values()].map(stop => stop()))
    const close = s.driver.close(s.handle)
    s.controller.abort(new Error('middleware session closed'))
    await close
    if (tails.some(result => result.status === 'rejected')) throw new Error('middleware tail cleanup failed')
    s.handle.closed = true
    s.tails.clear()
    await runtime.release(s.token)
    if (sessions.get(s.sessionKey) === s) sessions.delete(s.sessionKey)
  })()
  return s.closing
}

async function mwClose(pluginId: string, sessionKey: string): Promise<boolean> {
  const attempt = opening.get(sessionKey)
  if (attempt) {
    if (attempt.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
    attempt.controller.abort(new Error('middleware connection cancelled'))
    await attempt.promise.catch(() => {})
    if (failedClosures.has(attempt.token)) throw new Error('middleware cancelled connection cleanup failed')
  }
  const s = sessions.get(sessionKey)
  if (s && s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  if (s) await closeSession(s)
  return true
}

function mwListSessions(pluginId: string): MwSessionInfo[] {
  return [...sessions.values()].filter(s => s.pluginId === pluginId && !s.closing && !s.handle.closed).map(toSessionInfo)
}

async function releaseMwSessions(pluginId: string): Promise<void> {
  stopped = true
  const attempts = [...opening.values()].filter(attempt => attempt.pluginId === pluginId)
  for (const attempt of attempts) attempt.controller.abort(new Error('middleware service is closing'))
  await Promise.allSettled(attempts.map(attempt => attempt.promise))
  const results = await Promise.allSettled([...sessions.values()].filter(s => s.pluginId === pluginId).map(closeSession))
  if (failedClosures.size || results.some(result => result.status === 'rejected')) throw new Error('middleware connection cleanup failed')
}

/** 变更类 action 在连接 readOnly 时统一拒绝（驱动不必重复检查） */
function assertNotReadOnly(s: MwSession, action: string): void {
  if (s.handle.readOnly && MW_MUTATING_ACTIONS.includes(action)) {
    throw new Error('Read-only connections cannot mutate middleware state')
  }
}

async function startTail(s: MwSession, input: { tailId: string; topic: string; filter?: string }): Promise<void> {
  if (s.tails.has(input.tailId) || s.startingTails.has(input.tailId)) throw new Error(`tail already started: ${input.tailId}`)
  const pending = (async () => {
    const stopHandle = await s.driver.tailStart(s.handle, { tailId: input.tailId, topic: input.topic, filter: input.filter }, message => {
      if (!s.closing && !s.controller.signal.aborted) ctxEmit(s, 'data', { sessionKey: s.sessionKey, tailId: input.tailId, message })
    })
    if (s.closing || s.controller.signal.aborted || s.handle.closed || sessions.get(s.sessionKey) !== s) { await stopHandle.stop(); throw new Error('mw session closed during tail start') }
    s.tails.set(input.tailId, () => stopHandle.stop())
  })()
  s.startingTails.set(input.tailId, pending)
  try { await pending } finally { s.startingTails.delete(input.tailId) }
}

/** 会话存活期内复用 open 注入的 emit 通道 */
function ctxEmit(s: MwSession, event: 'data' | 'error', payload: Record<string, unknown>): void {
  postEvent(s.pluginId, event === 'data' ? 'mw.data' : 'mw.error', payload)
}

async function mwWorkbenchService(pluginId: string, request: MwWorkbenchRequest): Promise<unknown> {
  if (!request || typeof request !== 'object') throw new Error('Invalid mw workbench request')
  if (stopped) throw new Error('middleware service is closing')
  const action = request.action
  const input = (request.input ?? {}) as Record<string, never> & { sessionKey?: string }
  // —— 无需会话的 action ——
  switch (action) {
    case 'kinds.list': return runtime.descriptors()
    case 'test': return mwTest(pluginId, request.input.config)
    case 'session.open': return mwOpen(pluginId, request.input)
    case 'session.close': return mwClose(pluginId, request.input.sessionKey)
    case 'session.list': return mwListSessions(pluginId)
  }
  // —— 会话内 action ——
  if (!('sessionKey' in input) || typeof input.sessionKey !== 'string') throw new Error('sessionKey required')
  const s = requireSession(pluginId, input.sessionKey)
  assertNotReadOnly(s, action)
  const h = s.handle
  switch (action) {
    // mw.query
    case 'overview': return s.driver.overview(h)
    case 'topics.list': return s.driver.topicsList(h, { search: request.input.search, includeInternal: request.input.includeInternal })
    case 'topic.describe': return s.driver.topicDescribe(h, request.input.topic)
    case 'exchanges.list': return s.driver.exchangesList(h, { search: request.input.search })
    case 'bindings.list': return s.driver.bindingsList(h, { source: request.input.source, destination: request.input.destination })
    case 'groups.list': return s.driver.groupsList(h, { search: request.input.search })
    case 'group.describe': return s.driver.groupDescribe(h, request.input.groupId)
    case 'clients.list': return s.driver.clientsList(h, { search: request.input.search })
    case 'messages.query': return s.driver.messagesQuery(h, request.input)
    case 'messages.get': return s.driver.messageGet(h, { topic: request.input.topic, messageId: request.input.messageId, partition: request.input.partition, offset: request.input.offset })
    case 'tail.start': return startTail(s, { tailId: request.input.tailId, topic: request.input.topic, filter: request.input.filter })
    case 'tail.stop': {
      await s.startingTails.get(request.input.tailId)?.catch(() => {})
      const stop = s.tails.get(request.input.tailId)
      if (!stop) return true
      await stop()
      s.tails.delete(request.input.tailId)
      return true
    }
    case 'configs.describe': return s.driver.configsDescribe(h, { topic: request.input.topic })
    case 'trace.message': return s.driver.traceMessage(h, { key: request.input.key })
    case 'retained.list': return s.driver.retainedList(h, { search: request.input.search })
    // mw.admin
    case 'topic.create': return s.driver.topicCreate(h, request.input.topic)
    case 'topic.update': return s.driver.topicUpdate(h, request.input.name, request.input.attrs)
    case 'topic.delete': return s.driver.topicDelete(h, request.input.name)
    case 'topic.purge': return s.driver.topicPurge(h, request.input.name)
    case 'partitions.grow': return s.driver.partitionsGrow(h, { topic: request.input.topic, count: request.input.count })
    case 'exchange.create': return s.driver.exchangeCreate(h, request.input.exchange)
    case 'exchange.delete': return s.driver.exchangeDelete(h, request.input.name)
    case 'binding.create': return s.driver.bindingCreate(h, request.input.binding)
    case 'binding.delete': return s.driver.bindingDelete(h, { source: request.input.source, destination: request.input.destination, propertiesKey: request.input.propertiesKey })
    case 'group.resetOffsets': return s.driver.groupResetOffsets(h, request.input)
    case 'client.kick': return s.driver.clientKick(h, request.input.clientId)
    case 'messages.send': return s.driver.messageSend(h, request.input)
    case 'messages.resend': return s.driver.messageResend(h, { message: request.input.message, targetTopic: request.input.targetTopic })
    case 'configs.alter': return s.driver.configsAlter(h, { topic: request.input.topic, configs: request.input.configs })
    case 'retained.delete': return s.driver.retainedDelete(h, request.input.topic)
    default: throw new Error(`Unknown middleware workbench action: ${String(action)}`)
  }
}

return { mwWorkbenchService, mwTest, mwOpen, mwClose, mwListSessions, releaseMwSessions }
}
