import { sessionsList, sessionsRead, saveTextFile } from './api.js'
/**
 * com.github.eNest.ccswitch — 会话浏览器
 * 数据源：插件后端 sessions.list / sessions.read（只读白名单通道）。
 * 解析（语义移植自 cc-switch session_manager providers/claude.rs、session_usage.rs）：
 * - 列表：读文件头尾行提取 sessionId / cwd / 首条用户消息（标题）/ 首尾时间戳
 * - 详情：逐行 → 轮次（user / assistant / tool），usage 提取 token 供用量页复用
 * - resume 命令：claude --resume <id>；codex：codex resume <id>
 * 命名空间挂 window.CCS.sessions。
 */

/* —— 各应用 resume 命令 —— */
const RESUME_CMD = {
  'claude-code': (id) => 'claude --resume ' + id,
  codex: (id) => 'codex resume ' + id,
  'gemini-cli': (id) => 'gemini --resume ' + id,
  opencode: (id) => 'opencodes ' + id,
  'grok-build': (id) => 'grok resume ' + id,
  'minimax-code': (id) => 'mcode resume ' + id
}

function tsToMs(ts) {
  if (!ts || typeof ts !== 'string') return null
  const t = Date.parse(ts)
  return Number.isFinite(t) ? t : null
}

/** 从 content（string | [{type:'text',text}]）提取纯文本 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
  }
  return ''
}

/** 会话列表条目解析：读头尾若干行（claude jsonl 语义） */
function parseSessionMeta(file, lines) {
  const head = lines.slice(0, 12)
  const tail = lines.slice(-24)
  let sessionId = null
  let cwd = null
  let createdAt = null
  let firstUser = null
  let lastActiveAt = null
  let summary = null
  let messageCount = 0

  for (const line of head) {
    const v = line.json
    if (!v || typeof v !== 'object') continue
    if (!sessionId && typeof v.sessionId === 'string') sessionId = v.sessionId
    if (!cwd && typeof v.cwd === 'string') cwd = v.cwd
    if (!createdAt) createdAt = tsToMs(v.timestamp)
    if (!firstUser) {
      const isUser = v.type === 'user' || v.message?.role === 'user'
      if (isUser && v.message) {
        const text = String(contentText(v.message.content) || '').trim()
        if (
          text &&
          !text.includes('<local-command-caveat>') &&
          !text.startsWith('<command-name>') &&
          !text.startsWith('<system-reminder>')
        ) {
          firstUser = text
        }
      }
    }
  }
  for (const line of tail) {
    const v = line.json
    if (!v || typeof v !== 'object') continue
    if (!lastActiveAt) lastActiveAt = tsToMs(v.timestamp)
    if (!summary && v.message && v.type !== 'user') {
      const text = String(contentText(v.message.content) || '').trim()
      if (text) summary = text
    }
  }
  messageCount = lines.filter(l => l.json && (l.json.type === 'user' || l.json.type === 'assistant')).length

  const fallbackId = file.file.replace(/\.jsonl?$/, '').split('/').pop()
  return {
    file: file.file,
    path: file.path,
    bytes: file.bytes,
    modifiedAt: file.modifiedAt,
    project: file.project || cwd || '',
    sessionId: sessionId || fallbackId,
    title: (firstUser || summary || cwd || file.file).slice(0, 80),
    createdAt,
    lastActiveAt: lastActiveAt || file.modifiedAt,
    messageCount
  }
}

/* —— 会话详情：逐轮折叠 —— */
/** 行 → 轮次数组（user / assistant / tool） */
function parseTurns(lines) {
  const turns = []
  for (const line of lines) {
    const v = line.json
    if (!v || typeof v !== 'object') continue
    if (v.isSidechain === true || v.isMeta === true) continue
    const ts = tsToMs(v.timestamp)

    if (v.type === 'user' || v.message?.role === 'user') {
      const content = v.message?.content
      // tool_result 块 → tool 轮
      if (Array.isArray(content) && content.some(b => b?.type === 'tool_result')) {
        const results = content.filter(b => b?.type === 'tool_result')
        for (const r of results) {
          turns.push({
            role: 'tool',
            ts,
            title: '工具结果' + (r.tool_use_id ? ' · ' + r.tool_use_id.slice(0, 8) : ''),
            text: String(contentText(r.content) || r.content || '').slice(0, 4000),
            isError: r.is_error === true
          })
        }
      } else {
        const text = contentText(content)
        if (text.trim()) {
          turns.push({ role: 'user', ts, title: '用户', text: text.slice(0, 8000) })
        }
      }
      continue
    }
    if (v.type === 'assistant' || v.message?.role === 'assistant') {
      const content = v.message?.content
      const usage = v.message?.usage || null
      const model = v.message?.model || ''
      const text = contentText(content)
      const toolCalls = Array.isArray(content)
        ? content.filter(b => b?.type === 'tool_use').map(b => `${b.name} ${JSON.stringify(b.input || {}).slice(0, 120)}`)
        : []
      if (text.trim() || toolCalls.length) {
        turns.push({
          role: 'assistant',
          ts,
          title: model ? model : '助手',
          text: (text || toolCalls.join('\n')).slice(0, 12000),
          usage: usage
            ? {
                input: usage.input_tokens || 0,
                output: usage.output_tokens || 0,
                cacheRead: usage.cache_read_input_tokens || 0,
                cacheWrite: usage.cache_creation_input_tokens || 0
              }
            : null,
          toolCalls
        })
      }
      continue
    }
    // codex rollout 事件
    if (v.type === 'event_msg' && v.payload?.type === 'token_count') {
      // 用量快照（codex 语义）：usage 页消费
      continue
    }
  }
  return turns
}

/* —— API 封装 —— */
async function listSessions(app) {
  const roots = await sessionsList(app)
  const sessions = []
  for (const root of roots || []) {
    for (const file of root.files || []) {
      // 列表阶段只读头尾：maxBytes 64KB 已覆盖首尾行
      try {
        const r = await sessionsRead(app, file.file, 64 * 1024)
        sessions.push(parseSessionMeta(file, r.lines))
      } catch {
        // 单文件失败不阻塞列表
        sessions.push({
          file: file.file, path: file.path, bytes: file.bytes, modifiedAt: file.modifiedAt,
          project: file.project || '', sessionId: file.file, title: file.file,
          createdAt: null, lastActiveAt: file.modifiedAt, messageCount: 0
        })
      }
    }
  }
  sessions.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
  return sessions
}

async function readSession(app, file) {
  const r = await sessionsRead(app, file)
  return {
    meta: r,
    turns: parseTurns(r.lines),
    truncated: r.truncated,
    lines: r.lines.length
  }
}

function resumeCommand(app, sessionId) {
  const builder = RESUME_CMD[app]
  return builder ? builder(sessionId) : sessionId
}

/** 导出 Markdown（shell.saveTextFile） */
function toMarkdown(session, detail) {
  const out = []
  out.push('# ' + (session.title || session.sessionId))
  out.push('')
  out.push('- 应用：' + session.app)
  out.push('- 会话：' + session.sessionId)
  out.push('- 项目：' + (session.project || '—'))
  out.push('- 时间：' + new Date(session.lastActiveAt || Date.now()).toLocaleString('zh-CN'))
  out.push('')
  for (const turn of detail.turns) {
    const label = turn.role === 'user' ? '👤 用户' : turn.role === 'assistant' ? '🤖 助手' : '🔧 工具'
    out.push('## ' + label + (turn.title && turn.role !== 'user' ? ' · ' + turn.title : ''))
    out.push('')
    out.push(turn.text || '')
    if (turn.usage) {
      out.push('')
      out.push('> tokens: in ' + turn.usage.input + ' / out ' + turn.usage.output +
        (turn.usage.cacheRead ? ' / cacheR ' + turn.usage.cacheRead : ''))
    }
    out.push('')
  }
  if (detail.truncated) out.push('\n> 注：会话文件较大，仅导出前 512KB。')
  return out.join('\n')
}

async function exportMarkdown(session, detail) {
  const md = toMarkdown(session, detail)
  return saveTextFile({
    defaultName: 'session-' + session.sessionId + '.md',
    filename: 'session-' + session.sessionId + '.md',
    content: md
  })
}

export { RESUME_CMD, listSessions, readSession, resumeCommand, parseSessionMeta, parseTurns, toMarkdown, exportMarkdown }
