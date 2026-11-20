/**
 * session.mjs — A2UI 会话封装（渲染侧 MessageProcessor + agent 侧目录协商）
 * A2uiHost 职责：
 *   1. 渲染：MessageProcessor（basicCatalog + dbAiCatalog），action 回调 → onAction 路由
 *      （运行中交给 agent 循环消费；空闲时作为新 user 输入续跑）
 *   2. agent 侧：A2uiGenerator 的目录把 SqlConfirm 剪掉（模型生成不了确认卡），
 *      promptSnippet 由 agent.mjs 取用
 *   3. 线报账本：apply(messages) 同时进 processor 和账本（持久化用），
 *      并把 UI 状态变化通知 React（surfaces 列表 + 世代号）
 *   4. 工具结果注入：injectToolResult(toolIndex, structured) 合成 updateDataModel
 *      到 /toolResults/<i>，让模型用 @path 绑定数据而不回显 JSON
 *   5. SqlConfirm：createConfirmSurface 由 app 调用（agent.mjs 的 isWriteCall 命中时），
 *      action 回传 resolve Promise；结算后更新 settled 状态标灰保留
 *   6. 回放：replay(messages) 清空后逐条重放历史线报（切换会话/重启恢复）
 */

import { MessageProcessor, basicCatalog, injectBasicCatalogStyles, setMarkdownRenderer } from '@a2ui/web_core/v1_0'
import { renderMarkdown } from '@a2ui/markdown-it'
import { A2uiGenerator, CatalogConfig, ComponentPruningTransformer, RendererState, ExpressFormatFactory } from '@a2ui/agent'
import { dbAiCatalog, DB_AI_CATALOG_ID, APP_ONLY_COMPONENTS } from './catalog.jsx'
import { summarizeArgs } from '../confirm.mjs'

let stylesInjected = false
function ensureStyles() {
  if (stylesInjected) return
  stylesInjected = true
  injectBasicCatalogStyles()
  setMarkdownRenderer(renderMarkdown)
}

/* ── agent 侧目录（剪掉 app 专用组件）── */

/** 模型可见目录：dbAiCatalog 经 ComponentPruningTransformer 剪掉 SqlConfirm */
export function buildModelCatalogConfig() {
  const transformer = new ComponentPruningTransformer(
    [...dbAiCatalog.components.keys()].filter((name) => !APP_ONLY_COMPONENTS.includes(name))
  )
  return new CatalogConfig(dbAiCatalog, [transformer])
}

let generatorCache = null
/** A2uiGenerator（agent 侧）：promptSnippet + openStream 解析器工厂 */
export function getA2uiGenerator() {
  ensureStyles()
  if (!generatorCache) {
    generatorCache = new A2uiGenerator([new CatalogConfig(basicCatalog), buildModelCatalogConfig()], undefined, new ExpressFormatFactory())
  }
  return generatorCache
}

/* ── 渲染侧 host ── */

let hostSeq = 0

export function createA2uiHost({ onAction } = {}) {
  ensureStyles()
  const id = `host_${Date.now().toString(36)}_${++hostSeq}`

  /** 线报账本：surfaceId -> AgentToRendererMessage[]（重放与持久化的真源） */
  const ledger = []
  /** 确认卡 resolver：surfaceId -> (ok: boolean) => void */
  const confirmResolvers = new Map()
  /** app 注入的回调（SqlConfirm 卡上的 onConfirm/onCancel/onOpenInEditor）——不可序列化，不进账本 */
  const liveCallbacks = new Map()

  const processor = new MessageProcessor(
    [basicCatalog, dbAiCatalog],
    (action) => {
      // SqlConfirm 卡的结算回调在 createConfirmSurface 里直接绑定，不走 action 通道；
      // 其余 action（basic 组件 onConfirm 等）按运行状态路由
      onAction?.(action)
    }
  )

  /* UI 订阅面：React 侧轮询世代号 + surfaces 快照（避免 setState 风暴） */
  let revision = 0
  const listeners = new Set()
  function notify() {
    revision += 1
    for (const fn of listeners) fn(revision)
  }
  processor.onSurfaceCreated(() => notify())
  processor.onSurfaceDeleted(() => notify())

  /* ── 线报应用 ── */

  function apply(messages) {
    if (!Array.isArray(messages) || !messages.length) return
    processor.processMessages(messages)
    for (const message of messages) ledger.push(message)
    notify()
  }

  /* ── 工具结果注入 ── */

  function injectToolResult(surfaceId, toolIndex, structured) {
    const value = sanitizeForDataModel(structured)
    apply([{ version: 'v1.0', updateDataModel: { surfaceId, path: `/toolResults/${toolIndex}`, value } }])
  }

  /** dataModel 必须是纯 JSON 可持久化结构；Set/Map/循环引用收敛为可表述形式 */
  function sanitizeForDataModel(input, depth = 0) {
    if (depth > 8) return '[深度截断]'
    if (input === null || input === undefined) return null
    if (typeof input !== 'object') return input
    if (Array.isArray(input)) return input.slice(0, 400).map((item) => sanitizeForDataModel(item, depth + 1))
    if (input instanceof Map) return sanitizeForDataModel(Object.fromEntries(input), depth + 1)
    if (input instanceof Set) return [...input].map((item) => sanitizeForDataModel(item, depth + 1))
    const out = {}
    for (const [key, value] of Object.entries(input).slice(0, 200)) {
      try { out[key] = sanitizeForDataModel(value, depth + 1) } catch { out[key] = null }
    }
    return out
  }

  /* ── SqlConfirm（app 专用）── */

  function createConfirmSurface({ callId, name, args, onOpenInEditor }) {
    const surfaceId = `confirm_${callId || Date.now().toString(36)}`
    const isQuery = name === 'db_query'
    const sql = isQuery ? String(args?.sql || '') : ''
    const settle = (ok) => {
      const resolver = confirmResolvers.get(surfaceId)
      confirmResolvers.delete(surfaceId)
      // 结算后更新卡面（标灰保留）：替换 root 组件的 settled prop
      apply([{
        version: 'v1.0',
        updateComponents: {
          surfaceId,
          components: [{
            id: 'root',
            component: 'SqlConfirm',
            catalogId: DB_AI_CATALOG_ID,
            tool: name,
            summary: summarizeArgs(name, args),
            ...(sql ? { sql } : {}),
            settled: ok ? 'done' : 'cancelled'
          }]
        }
      }])
      liveCallbacks.delete(surfaceId)
      resolver?.(ok)
    }
    const callbacks = {
      onConfirm: () => settle(true),
      onCancel: () => settle(false),
      ...(onOpenInEditor && sql ? { onOpenInEditor: () => onOpenInEditor(sql) } : {})
    }
    liveCallbacks.set(surfaceId, callbacks)
    apply([{
      version: 'v1.0',
      createSurface: {
        surfaceId,
        catalogId: DB_AI_CATALOG_ID,
        components: [{
          id: 'root',
          component: 'SqlConfirm',
          catalogId: DB_AI_CATALOG_ID,
          tool: name,
          summary: summarizeArgs(name, args),
          ...(sql ? { sql } : {}),
          ...callbacks,
          settled: ''
        }]
      }
    }])
    return {
      surfaceId,
      done: () => confirmResolvers.has(surfaceId),
      promise: new Promise((resolve) => confirmResolvers.set(surfaceId, resolve))
    }
  }

  /* ── 回放与清理 ── */

  function reset() {
    for (const surface of [...processor.getSurfaces().keys()]) {
      processor.processMessages([{ version: 'v1.0', deleteSurface: { surfaceId: surface } }])
    }
    ledger.length = 0
    for (const resolver of confirmResolvers.values()) resolver(false)
    confirmResolvers.clear()
    liveCallbacks.clear()
    notify()
  }

  /** 历史回放：processor 清空后逐条重放线报；SqlConfirm 卡回放为已结算静态卡。
   *  回放只为恢复界面——ledger 清空，后续 takeA2ui 只取新轮线报，不重复持久化历史。 */
  function replay(messages) {
    reset()
    const replayable = []
    for (const message of messages || []) {
      const created = message?.createSurface?.surfaceId
      if (created && liveCallbacksStripped(message)) {
        // app 生成的确认卡：回放时去掉回调、标灰
        replayable.push(stripConfirmCallbacks(message, true))
        continue
      }
      replayable.push(message)
    }
    processor.processMessages(replayable)
    ledger.length = 0
    notify()
  }

  function liveCallbacksStripped(message) {
    return message?.createSurface?.components?.some?.(
      (c) => c?.component === 'SqlConfirm' && (c.onConfirm || c.onCancel || c.onOpenInEditor)
    )
  }

  function stripConfirmCallbacks(message, settled) {
    const clone = structuredCloneSafe(message)
    const components = clone.createSurface.components.map((c) =>
      c.component === 'SqlConfirm'
        ? { ...c, onConfirm: undefined, onCancel: undefined, onOpenInEditor: undefined, settled: settled ? 'done' : (c.settled || 'cancelled') }
        : c
    )
    clone.createSurface.components = components
    return clone
  }

  function structuredCloneSafe(value) {
    try { return structuredClone(value) } catch { return JSON.parse(JSON.stringify(value)) }
  }

  function dispose() {
    reset()
    processor.dispose()
    listeners.clear()
  }

  return {
    id,
    processor,
    ledger,
    apply,
    injectToolResult,
    createConfirmSurface,
    replay,
    reset,
    dispose,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getRevision: () => revision,
    getSurfaces: () => [...processor.getSurfaces().values()],
    /** 渲染器能力声明（agent 侧 createProcessor 协商用） */
    getCapabilities() {
      return processor.getRendererCapabilities({ versions: ['1.0'], includeInlineCatalogs: false })
    },
    /** agent 侧请求处理器（detached RendererState：纯校验镜像，不自动应用到渲染器——
     *  应用只走 host.apply 一条通道，避免 RendererState.of(processor) 的自动应用
     *  与 applyA2ui 显式应用叠加成 INTEGRITY_ERROR）。目录 = 剪枝后的模型目录。 */
    createRequestState() {
      const generator = getA2uiGenerator()
      const basicConfig = new CatalogConfig(basicCatalog)
      const dbConfig = buildModelCatalogConfig()
      return generator.createProcessor(
        this.getCapabilities(),
        undefined,
        { state: new RendererState([basicConfig.transformedCatalog, dbConfig.transformedCatalog]) }
      )
    }
  }
}
