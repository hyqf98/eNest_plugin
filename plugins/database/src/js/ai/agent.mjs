/**
 * agent.mjs — AI 会话循环状态机（A2UI 版）
 * idle → streaming → executing(tools) → [awaiting-confirm] → streaming … → idle
 * 每会话单 flight（运行中忽略新输入）；最多 12 轮工具循环。
 * 会话键：AI 专用 ::ai 后缀，按连接 id 可存多个；未打开先自动 connection.open 再重试。
 * A2UI：system prompt 附加 a2uiProcessor.promptSnippet（Express 格式 + 目录）；
 *   onDelta 文本喂 openStream().feed()，产出 {text|a2ui} 分流——text 进流式气泡
 *   （气泡文本只来自解析器吐出的部分，避免 <a2ui 标记闪现），a2ui 线报经
 *   ui.applyA2ui 落渲染器；坏块 afterRejectedBlock:'continue' 跳过不杀流。
 *   工具结果经 ui.injectToolResult 注入本轮 surfaces 的 dataModel /toolResults/<i>。
 * 写操作：aiConfirmWrites 开启时 app 创建 SqlConfirm surface（模型目录剪掉了该组件），
 *   确认后带 confirmed:true 执行；取消把「用户拒绝执行」作为工具错误回给模型。
 * 停止：abort fetch + 未完成 tool 标 cancelled，历史保留可续答。
 */

import { chat, defaultProvider, listProviders } from './models.mjs'
import { TOOL_DEFS, toolIdOf } from './toolDefs.mjs'
import { execTool } from '../tools/dbTools.mjs'
import { isWriteCall } from './confirm.mjs'
import { getConnection, state } from '../store.js'
import { autoTitle, persistSession } from './sessions.mjs'

const MAX_ROUNDS = 12
const TOOL_RESULT_CAP = 24 * 1024
const AI_CTX = () => ({ sessions: aiSessions, suffix: '::ai' })

/** AI 专用会话映射：connectionId -> sessionKey（::ai 后缀，与 MCP/控制台隔离） */
const aiSessions = new Map()

export function aiSessionMap() {
  return aiSessions
}

/** 当前绑定连接（工作台活动连接；连接 chip 随切换更新 system 上下文） */
let boundConnectionId = null

export function setBoundConnection(id) {
  boundConnectionId = id || null
}

export function getBoundConnection() {
  return boundConnectionId ? getConnection(boundConnectionId) : null
}

/** 组装 system 提示：角色 + 环境 + 守则 + A2UI 目录片段 */
function systemPrompt(connection, promptSnippet) {
  const env = connection
    ? `当前绑定连接：「${connection.name}」(${connection.driver}${connection.env ? ` · ${connection.env}` : ''}${connection.readOnly ? ' · 只读' : ''})，connectionId=${connection.id}`
    : '当前未绑定连接；需要数据库信息时先调用 db_connections_list，再 db_connection_open。'
  return [
    '你是数据库工作台里的 AI 助手，帮助用户查询与理解数据库。',
    `环境：${env}`,
    '守则：',
    '- 默认只读：优先用 SELECT/EXPLAIN/schema 工具；执行写操作前先用一句话说明意图。',
    '- 大结果先 COUNT 评估规模，再决定取多少行；工具结果每个结果集最多 400 行。',
    '- 需要展示界面（图表/表格/交互卡）时按 A2UI Express 格式输出；工具结果已注入',
    '  surface 数据模型的 /toolResults/<序号>，DbTable 的 columns/rows 与 EChart 的 option',
    '  优先用 $/toolResults/<n>/... 路径绑定，不要在组件里回显大块数据。',
    '  纯文字回答不必生成 surface；简短 SQL 片段直接放 ```sql 代码块。',
    '- 连接配置的创建与凭据授权只能在插件界面完成，不要尝试新建连接。',
    '- 用中文回答；结论放前面，过程简短。',
    '',
    promptSnippet
  ].join('\n')
}

/** 历史压缩：turn 压缩为「[调用 db_query(摘要) → text 摘要]」，最近 2 轮保留 structured */
function historyMessages(session) {
  const out = []
  for (const message of session.messages) {
    if (message.role === 'user') out.push({ role: 'user', content: String(message.content || '') })
    else if (message.role === 'assistant' && message.content) out.push({ role: 'assistant', content: String(message.content).slice(0, 4000) })
  }
  const turns = session.messages.filter((message) => message.role === 'assistant-turn')
  const recentTurns = new Set(turns.slice(-2))
  for (const turn of turns) {
    const calls = (turn.toolCalls || []).map((call) => {
      const summary = call.status === 'error'
        ? `错误: ${String(call.text || '').slice(0, 120)}`
        : String(call.text || '').slice(0, 160)
      const argSummary = call.args?.sql
        ? String(call.args.sql).replace(/\s+/g, ' ').slice(0, 60)
        : Object.keys(call.args || {}).slice(0, 4).join(',')
      return `[调用 ${call.tool}(${argSummary}) → ${summary}]`
    })
    if (calls.length) out.push({ role: 'user', content: calls.join('\n') })
    if (turn.content) out.push({ role: 'assistant', content: String(turn.content).slice(0, 2000) })
    if (recentTurns.has(turn)) {
      for (const call of turn.toolCalls || []) {
        if (call.status === 'ok' && call.structured) {
          try {
            out.push({ role: 'user', content: `工具 ${call.tool} 的结构化结果（截断）：${JSON.stringify(call.structured).slice(0, 3000)}` })
          } catch { /* 不可序列化结构跳过 */ }
        }
      }
    }
  }
  return out.slice(-30)
}

/** tool 结果回填消息（content=text + JSON 摘要，截 24KB） */
function toolResultContent(text, structured) {
  const parts = [String(text || '')]
  if (structured !== undefined && structured !== null) {
    try { parts.push(JSON.stringify(structured)) } catch { /* 不可序列化 */ }
  }
  const joined = parts.join('\n')
  return joined.length > TOOL_RESULT_CAP ? `${joined.slice(0, TOOL_RESULT_CAP)}…（结果过长已截断）` : joined
}

function isAbort(error) {
  return error?.name === 'AbortError' || /已停止|aborted|abort/i.test(String(error?.message || ''))
}

/** 单个工具执行（含自动 open ::ai 会话重试）；返回 { text, structured } 或 throw */
async function execWithAutoOpen(toolId, args, connection) {
  try {
    return await execTool(toolId, args, AI_CTX())
  } catch (error) {
    if (/尚未打开/.test(String(error?.message || '')) && connection && args.connectionId) {
      await execTool('connection.open', { connectionId: args.connectionId }, AI_CTX())
      return execTool(toolId, args, AI_CTX())
    }
    throw error
  }
}

/** 线报里出现的 surfaceId（createSurface 顺序） */
function surfacesOf(messages) {
  const ids = []
  for (const message of messages || []) {
    const sid = message?.createSurface?.surfaceId
    if (sid) ids.push(sid)
  }
  return ids
}

/**
 * 执行一轮用户输入。ui 契约（panel 提供，全部可选但运行中必须实现）：
 *   beginTurn() / pushText(delta) / endStream()          流式气泡生命周期
 *   beginTurnEntries(entries) / syncTurnEntry() / finishTurn()   工具轮次实时状态
 *   applyA2ui(messages) -> createdSurfaceIds              A2UI 线报落渲染器
 *   takeA2ui() -> messages                                取走累积线报（持久化用）
 *   injectToolResult(toolIndex, structured)               工具结果注入本轮 surfaces
 *   a2uiProcessor() -> processor | null                   agent 侧请求处理器（含 promptSnippet）
 *   confirm({ callId, name, args, onOpenInEditor }) -> Promise<boolean>   SqlConfirm surface
 *   notice(message) / openInEditor(sql) / done()
 */
export function createAgent(ui) {
  let running = false
  let controller = null

  async function run(session, input) {
    if (running) return false
    running = true
    controller = new AbortController()
    const signal = controller.signal
    session.messages.push({ role: 'user', content: String(input || ''), at: Date.now() })
    autoTitle(session, input)
    persistSession(session.id)

    const providers = await listProviders()
    const provider = defaultProvider(providers)
    if (!provider) {
      ui.notice?.('尚未配置 AI 模型供应商，请到数据库设置 → AI 助手添加。')
      running = false
      controller = null
      ui.done?.()
      return true
    }

    const connection = getBoundConnection()

    // agent 侧 A2UI 请求处理器（panel 经 host 提供，绑定渲染器能力协商）
    let a2uiProcessor = null
    try {
      a2uiProcessor = ui.a2uiProcessor?.() || null
    } catch { a2uiProcessor = null }
    const conversation = [{ role: 'system', content: systemPrompt(connection, a2uiProcessor?.promptSnippet || '') }, ...historyMessages(session)]

    try {
      for (let round = 1; round <= MAX_ROUNDS; round += 1) {
        // 1) streaming：文本经解析器进气泡（不闪 <a2ui 标记）；线报落渲染器
        ui.beginTurn?.()
        const stream = a2uiProcessor?.openStream({ afterRejectedBlock: 'continue' }) || null
        let text = ''
        let result
        const consumePart = (part) => {
          if (part.type === 'text') {
            if (part.text) { text += part.text; ui.pushText?.(part.text) }
          } else if (part.type === 'a2ui') {
            ui.applyA2ui?.(part.a2ui)
          }
          // error part：afterRejectedBlock:'continue' 的坏块，文本回退继续
        }
        try {
          const onDelta = (chunk) => {
            if (!stream) {
              text += chunk
              ui.pushText?.(chunk)
              return
            }
            try {
              for (const part of stream.feed(chunk)) consumePart(part)
            } catch { /* 坏 chunk：解析器已尽力吐出部分，跳过 */ }
          }
          // 思维链与正文分流：reasoning 只进思考行，不混进回答气泡。
          const onReasoning = (chunk) => { ui.pushReasoning?.(chunk) }
          result = await chat({
            provider, messages: conversation, toolDefs: TOOL_DEFS, onDelta, onReasoning, signal,
            reasoningEffort: state.ui.aiReasoningEffort
          })
          if (stream) {
            try { for (const part of stream.close()) consumePart(part) } catch { /* 收尾坏块：丢弃 */ }
          }
        } catch (error) {
          ui.endStream?.()
          throw error
        }
        ui.endStream?.()

        // 2) 无工具调用：最终回答（text 为去掉 A2UI 块的纯文本），落库退出
        if (!result.toolCalls.length) {
          const a2uiMessages = ui.takeA2ui?.() || []
          session.messages.push({ role: 'assistant', content: text || result.content, at: Date.now(), ...(a2uiMessages.length ? { a2ui: a2uiMessages, surfaces: surfacesOf(a2uiMessages) } : {}) })
          break
        }

        // 3) executing(tools)：实时工具轮次，逐个顺序执行
        const turnStarted = Date.now()
        const turnMessage = {
          role: 'assistant-turn',
          toolCalls: result.toolCalls.map((call) => ({ tool: call.name, args: call.args, status: 'running', text: '', structured: undefined, ms: null })),
          content: text,
          at: Date.now()
        }
        session.messages.push(turnMessage)
        conversation.push({
          role: 'assistant',
          content: text || '',
          tool_calls: result.toolCalls.map((call, index) => ({
            id: call.id || `call_${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
          }))
        })

        ui.beginTurnEntries?.(turnMessage.toolCalls)
        let cancelledHere = false

        for (let i = 0; i < turnMessage.toolCalls.length; i += 1) {
          const entry = turnMessage.toolCalls[i]
          const call = result.toolCalls[i]
          const toolId = toolIdOf(call.name)
          const args = { ...(call.args || {}) }
          // 会话键自动注入：绑定连接优先（显式 sessionKey/ connectionId 不覆盖）
          if (connection && args.connectionId === undefined && args.sessionKey === undefined) args.connectionId = connection.id
          const started = Date.now()

          try {
            if (signal.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' })

            // awaiting-confirm：写操作确认（app 生成 SqlConfirm surface）
            if (isWriteCall(call.name, args) && state.ui.aiConfirmWrites !== false) {
              const ok = await ui.confirm({ callId: call.id || `call_${i}`, name: call.name, args, onOpenInEditor: ui.openInEditor })
              if (signal.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' })
              if (!ok) {
                entry.status = 'error'
                entry.text = '用户拒绝执行'
                entry.ms = Date.now() - started
                ui.syncTurnEntry?.()
                conversation.push({ role: 'tool', tool_call_id: call.id || `call_${i}`, content: '用户拒绝执行' })
                continue
              }
              args.confirmed = true
            }

            const outcome = await execWithAutoOpen(toolId, args, connection)
            entry.status = 'ok'
            entry.text = outcome.text
            entry.structured = outcome.structured
            // 工具结果注入本轮 surfaces 的 dataModel（@path /toolResults/<i> 可绑）
            ui.injectToolResult?.(i, outcome.structured)
          } catch (error) {
            if (isAbort(error) || signal.aborted) {
              entry.status = 'cancelled'
              cancelledHere = true
            } else {
              entry.status = 'error'
              entry.text = String(error?.message || error)
            }
          }
          entry.ms = Date.now() - started
          ui.syncTurnEntry?.()
          conversation.push({
            role: 'tool',
            tool_call_id: call.id || `call_${i}`,
            content: entry.status === 'error'
              ? toolResultContent(entry.text, undefined)
              : toolResultContent(entry.text, entry.structured)
          })
        }
        // 轮次结算：计时 + 线报并入消息持久化
        turnMessage.ms = Date.now() - turnStarted
        const turnA2ui = ui.takeA2ui?.() || []
        if (turnA2ui.length) {
          turnMessage.a2ui = turnA2ui
          turnMessage.surfaces = surfacesOf(turnA2ui)
        }
        ui.finishTurn?.()
        persistSession(session.id)
        if (cancelledHere || signal.aborted) break
      }
    } catch (error) {
      if (isAbort(error)) ui.notice?.('已停止；可以继续提问接上。')
      else ui.notice?.(String(error?.message || error))
    } finally {
      // 异常退出也要把已产出的线报并入最后一条消息，避免丢失已渲染界面
      const leftover = ui.takeA2ui?.() || []
      if (leftover.length) {
        const last = session.messages[session.messages.length - 1]
        if (last && (last.role === 'assistant' || last.role === 'assistant-turn') && !last.a2ui) {
          last.a2ui = leftover
          last.surfaces = surfacesOf(leftover)
        } else if (last?.role === 'user') {
          session.messages.push({ role: 'assistant', content: '', at: Date.now(), a2ui: leftover, surfaces: surfacesOf(leftover) })
        }
      }
      persistSession(session.id)
      running = false
      controller = null
      ui.done?.()
    }
    return true
  }

  return {
    run: (session, input) => run(session, input),
    isRunning: () => running,
    stop() {
      controller?.abort()
    }
  }
}
