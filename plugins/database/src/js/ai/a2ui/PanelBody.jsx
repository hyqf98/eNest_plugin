/**
 * PanelBody.jsx — AI 面板消息区（React 渲染层，替换旧 render.mjs/markdownLite.mjs）
 * 结构：imperative 壳（panel.mjs）持有 host（a2ui/session.mjs），把 body 交给这里的
 * PanelBody 渲染。消息模型（sessions.mjs 持久化）：
 *   user{content} / assistant{content, surfaces?} / assistant-turn{toolCalls[], content, surfaces?}
 * assistant 消息的 surfaces = 该轮 A2UI 线报产出的 surfaceId 列表（回放用 host.ledger 重放）。
 * 流式：agent 循环把当前轮的 live 状态（文本增量/当前 surfaces）推给 PanelBody。
 * markdown 用 @a2ui/markdown-it（DOMPurify 消毒），旧会话的 ```sql/```mermaid/```echarts
 * 围栏在 MarkdownBlock 里降级渲染（mermaid/echarts 走占位 + 懒渲染，保持旧回放可用）。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { A2uiSurface, MarkdownContext, useMarkdownRenderer } from '@a2ui/react'
import { renderMarkdown } from '@a2ui/markdown-it'
import { mountChartHolder, chartKindOfLegacy } from './legacyFence.mjs'
import { summarizeArgs } from '../confirm.mjs'
import { clipboardWrite } from '../../api.js'

/* ── markdown 块（含旧围栏降级）── */

function MarkdownBlock({ source, onOpenInEditor }) {
  const renderer = useMarkdownRenderer()
  const [html, setHtml] = useState('')
  const ref = useRef(null)
  useEffect(() => {
    let alive = true
    void renderer(source).then((out) => { if (alive) setHtml(out) }).catch(() => { if (alive) setHtml('') })
    return () => { alive = false }
  }, [renderer, source])

  // 旧围栏（mermaid/echarts）经 markdown-it 输出 <pre><code class="language-xxx">，
  // 渲染后扫描替换为懒渲染图表容器；sql 代码块挂复制/在编辑器打开
  useEffect(() => {
    const node = ref.current
    if (!node || !html) return
    for (const code of node.querySelectorAll('pre > code[class*="language-"]')) {
      const lang = /language-([\w-]+)/.exec(code.className || '')?.[1]?.toLowerCase() || ''
      const text = code.textContent || ''
      const kind = chartKindOfLegacy(lang)
      if (kind) {
        const holder = mountChartHolder(kind, text)
        code.parentElement.replaceWith(holder)
      } else {
        const pre = code.parentElement
        const block = document.createElement('div')
        block.className = 'dbai-codeblock'
        const head = document.createElement('div')
        head.className = 'dbai-code-head'
        head.innerHTML = `<span class="dbai-code-lang">${lang || 'text'}</span>`
        const actions = document.createElement('div')
        actions.className = 'dbai-code-actions'
        const copyBtn = document.createElement('button')
        copyBtn.type = 'button'
        copyBtn.className = 'dbai-iconbtn'
        copyBtn.textContent = '复制'
        copyBtn.onclick = async () => {
          await clipboardWrite(text)
          copyBtn.textContent = '已复制'
          setTimeout(() => { copyBtn.textContent = '复制' }, 1500)
        }
        actions.append(copyBtn)
        if (onOpenInEditor && ['sql', 'mysql', 'postgres', 'postgresql', 'sqlite'].includes(lang)) {
          const openBtn = document.createElement('button')
          openBtn.type = 'button'
          openBtn.className = 'dbai-iconbtn'
          openBtn.textContent = '在编辑器打开'
          openBtn.onclick = () => onOpenInEditor(text)
          actions.append(openBtn)
        }
        head.append(actions)
        const body = document.createElement('pre')
        body.className = 'dbai-code-body'
        body.textContent = text
        block.append(head, body)
        pre.replaceWith(block)
      }
    }
  }, [html, onOpenInEditor])

  return <div ref={ref} className="dbai-md" dangerouslySetInnerHTML={{ __html: html }} />
}

/* ── 工具轮次块 ── */

function fmtDuration(ms) {
  if (ms == null) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function ToolRow({ entry }) {
  const [open, setOpen] = useState(false)
  const summary = summarize(entry)
  return (
    <div className={`dbai-tool-row status-${entry.status || 'running'}`}>
      <div className="dbai-tool-head" onClick={() => setOpen((v) => !v)}>
        <span className={`dbai-tool-dot ${entry.status || 'running'}`} />
        <code className="dbai-tool-name">{entry.tool}</code>
        <span className="dbai-tool-summary">{summary}</span>
        <span className="dbai-tool-ms">{fmtDuration(entry.ms)}</span>
      </div>
      {open ? (
        <div className="dbai-tool-detail">
          <pre className="dbai-tool-args">{safeJson(entry.args)}</pre>
          {entry.text ? <div className="dbai-tool-result">{entry.text}</div> : null}
          <MiniTable structured={entry.structured} />
        </div>
      ) : null}
    </div>
  )
}

function summarize(entry) {
  try {
    return summarizeArgs(entry.tool, entry.args) || ''
  } catch { return '' }
}

function safeJson(value) {
  try { return JSON.stringify(value, null, 2) ?? 'null' } catch { return String(value) }
}

function MiniTable({ structured }) {
  const table = useMemo(() => {
    const results = structured?.results
    const first = Array.isArray(results) ? results.find((r) => Array.isArray(r?.rows) && r.rows.length) : null
    const plan = structured?.result
    const source = first || plan
    if (!source || !Array.isArray(source.columns) || !source.columns.length) return null
    return {
      columns: source.columns.slice(0, 6).map((col) => (typeof col === 'object' ? (col?.name ?? '') : String(col ?? ''))),
      rows: source.rows.slice(0, 8).map((row) => (Array.isArray(row) ? row : [row]).slice(0, 6).map((cell) => {
        if (cell === null || cell === undefined) return 'NULL'
        if (typeof cell === 'object') { try { return JSON.stringify(cell) } catch { return String(cell) } }
        return String(cell)
      })),
      total: source.rowCount ?? source.rows.length,
      truncated: !!source.truncated
    }
  }, [structured])
  if (!table) return null
  return (
    <div className="dbai-mini-wrap">
      <table className="dbai-mini-table">
        <thead><tr>{table.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>
          {table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} title={cell}>{cell.length > 60 ? `${cell.slice(0, 60)}…` : cell}</td>)}</tr>)}
        </tbody>
      </table>
      <div className="dbai-mini-foot">
        {table.total > table.rows.length ? `共 ${table.total} 行，已显示前 ${table.rows.length} 行${table.truncated ? '（已截断）' : ''}` : `共 ${table.total} 行`}
      </div>
    </div>
  )
}

function TurnBlock({ message, liveEntry }) {
  const [open, setOpen] = useState(true)
  const calls = message.toolCalls || []
  const running = calls.some((c) => c.status === 'running') || !!liveEntry
  const errors = calls.filter((c) => c.status === 'error').length
  const finished = message.ms != null
  const label = finished || !running
    ? `执行了 ${calls.length} 个工具${message.ms != null ? ` · 耗时 ${fmtDuration(message.ms)}` : ''}${errors ? ` · ${errors} 个失败` : ''}`
    : `执行中…（${calls.filter((c) => c.status !== 'running').length}/${calls.length}）`
  useEffect(() => { if (finished) setOpen(false) }, [finished])
  return (
    <div className={`dbai-turn${open ? ' open' : ''}${running ? ' running' : ''}`}>
      <button type="button" className="dbai-turn-head" onClick={() => setOpen((v) => !v)}>
        <span className="dbai-turn-label">{label}</span>
        <span className="dbai-turn-chevron">⌄</span>
      </button>
      <div className="dbai-turn-tree" hidden={!open}>
        {calls.map((call, i) => <ToolRow key={i} entry={call} />)}
      </div>
    </div>
  )
}

/* ── surfaces 渲染 ── */

function SurfaceList({ host, ids }) {
  const [revision, force] = useState(0)
  useEffect(() => host.subscribe(() => force((n) => n + 1)), [host])
  // revision 进 state：host.notify 触发重渲染时重算 surfaces；普通父级重渲染不重复建数组
  const surfaces = useMemo(() => {
    const all = host.getSurfaces()
    const byId = new Map(all.map((s) => [s.id, s]))
    return (ids || []).map((id) => byId.get(id)).filter(Boolean)
  }, [host, ids, revision])
  if (!surfaces.length) return null
  return <div className="dbai-surfaces">{surfaces.map((s) => <A2uiSurface key={s.id} surface={s} />)}</div>
}

/* ── 空态引导 ── */

function EmptyState({ connection, onSuggest }) {
  const suggestions = useMemo(() => {
    if (!connection) return ['列出所有连接', '查看当前库的表']
    return [`这个库有哪些表？`, `统计 ${connection.driver} 里最大的 5 张表`, '画一张 ER 图看看核心表关系']
  }, [connection])
  return (
    <div className="dbai-empty">
      <p>连接数据库后直接提问，我会调用数据库工具作答。</p>
      <div className="dbai-suggest">
        {suggestions.map((text) => (
          <button key={text} type="button" className="dbai-suggest-chip" onClick={() => onSuggest?.(text)}>{text}</button>
        ))}
      </div>
    </div>
  )
}

/* ── 主组件 ── */

/**
 * live：agent 循环推送的当前轮实时状态（panel 命令式侧 setLive 更新）：
 *   { phase: 'streaming'|'idle', text, turnEntries?: toolCall[], surfaces?: string[] }
 */
export function PanelBody({ host, session, live, connection, onSuggest, onOpenInEditor }) {
  const scrollRef = useRef(null)
  const messages = session?.messages || []

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, live?.text, live?.revision])

  return (
    <div className="dbai-body-inner" ref={scrollRef}>
      {!messages.length && !live?.text ? <EmptyState connection={connection} onSuggest={onSuggest} /> : null}
      {messages.map((message, i) => {
        if (message.role === 'user') {
          return (
            <div key={i} className="dbai-msg user">
              <div className="dbai-bubble">{message.content}</div>
            </div>
          )
        }
        if (message.role === 'assistant') {
          return (
            <div key={i} className="dbai-msg assistant">
              {message.surfaces?.length ? <SurfaceList host={host} ids={message.surfaces} /> : null}
              {message.content ? <MarkdownBlock source={message.content} onOpenInEditor={onOpenInEditor} /> : null}
            </div>
          )
        }
        if (message.role === 'assistant-turn') {
          return (
            <div key={i}>
              <TurnBlock message={message} />
              {message.surfaces?.length ? <SurfaceList host={host} ids={message.surfaces} /> : null}
              {message.content ? (
                <div className="dbai-msg assistant">
                  <MarkdownBlock source={message.content} onOpenInEditor={onOpenInEditor} />
                </div>
              ) : null}
            </div>
          )
        }
        return null
      })}
      {live?.phase === 'streaming' || live?.turnEntries?.length ? (
        <div>
          {live.turnEntries?.length ? <TurnBlock message={{ toolCalls: live.turnEntries, ms: null }} liveEntry /> : null}
          {live.phase === 'streaming' && live.text ? (
            <div className="dbai-msg assistant streaming">
              <div className="dbai-md dbai-stream-text">{live.text}<span className="dbai-cursor" /></div>
            </div>
          ) : null}
          {live.surfaces?.length ? <SurfaceList host={host} ids={live.surfaces} /> : null}
        </div>
      ) : null}
      {live?.notice ? <div className="dbai-msg assistant"><div className="dbai-error-notice">{live.notice}</div></div> : null}
    </div>
  )
}

/* ── 挂载入口（panel.mjs 命令式侧调用）── */

export function mountPanelBody(container, getProps) {
  const root = createRoot(container)
  let props = getProps()
  const render = () => {
    root.render(
      <MarkdownContext.Provider value={renderMarkdown}>
        <PanelBody {...props} />
      </MarkdownContext.Provider>
    )
  }
  render()
  return {
    update(next) { props = { ...props, ...next }; render() },
    unmount() { root.unmount() }
  }
}
