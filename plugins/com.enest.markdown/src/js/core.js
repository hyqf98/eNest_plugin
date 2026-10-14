/** 轻量 Markdown 渲染与工具：自研单遍分块解析，无外部依赖。供页面与 node 自测共用。 */

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** 行内语法：粗斜体、行内码、链接、图片、自动链接 */
function inline(text) {
  let s = escapeHtml(text)
  const codes = []
  // 先保护行内码，避免内部再被替换
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  // 图片 ![alt](src) —— src 支持 blob: dataURL
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" />`)
  // 链接 [text](href)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text2, href) => `<a href="${href}" target="_blank" rel="noopener">${text2}</a>`)
  // 自动链接（裸 http/https）
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`)
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)])
}

/** 解析表格块（含表头分隔行）；返回 html 或 null */
function tableHtml(lines) {
  if (lines.length < 2) return null
  const splitRow = (row) =>
    row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
  const header = splitRow(lines[0])
  if (!lines[1].match(/^\s*\|?[\s:|-]+\|?\s*$/) || !lines[1].includes('-')) return null
  const aligns = splitRow(lines[1]).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left',
  )
  const body = lines.slice(2)
  const cell = (c, i) => `<td style="text-align:${aligns[i] || 'left'}">${inline(c)}</td>`
  return (
    `<table><thead><tr>${header.map((c, i) => `<th style="text-align:${aligns[i] || 'left'}">${inline(c)}</th>`).join('')}</tr></thead>` +
    `<tbody>${body.map((row) => `<tr>${splitRow(row).map(cell).join('')}</tr>`).join('')}</tbody></table>`
  )
}

/**
 * 渲染 Markdown → HTML。
 * 支持：标题 / 粗斜 / 行内码 / 围栏代码块 / 引用 / 有序无序列表 / 任务清单 /
 * 链接 / 图片 / 表格 / 分隔线 / 自动链接；图片 src 直接输出（走 storage.blobs dataURL）。
 */
export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  let para = []
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`)
      para = []
    }
  }
  while (i < lines.length) {
    const line = lines[i]
    // 围栏代码块
    const fence = line.match(/^```\s*(\S*)\s*$/)
    if (fence) {
      flushPara()
      const buf = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++])
      i++ // 跳过闭合 ```
      const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : ''
      out.push(`<pre class="code-block"${lang}><code>${escapeHtml(buf.join('\n'))}</code></pre>`)
      continue
    }
    // 表格
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const buf = []
      while (i < lines.length && lines[i].includes('|')) buf.push(lines[i++])
      const html = tableHtml(buf)
      if (html) {
        flushPara()
        out.push(html)
        continue
      }
    }
    // 分隔线
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara()
      out.push('<hr />')
      i++
      continue
    }
    // 标题
    const head = line.match(/^(#{1,6})\s+(.*)$/)
    if (head) {
      flushPara()
      const level = head[1].length
      out.push(`<h${level}>${inline(head[2].replace(/\s#+\s*$/, ''))}</h${level}>`)
      i++
      continue
    }
    // 引用
    if (/^\s*>\s?/.test(line)) {
      flushPara()
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`)
      continue
    }
    // 任务清单 / 无序 / 有序列表（连续行聚合）
    const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/)
    const ul = line.match(/^\s*[-*]\s+(.*)$/)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (task || ul || ol) {
      flushPara()
      const kind = task ? 'task' : ul ? 'ul' : 'ol'
      const items = []
      while (i < lines.length) {
        const t = lines[i].match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/)
        const u = lines[i].match(/^\s*[-*]\s+(.*)$/)
        const o = lines[i].match(/^\s*\d+[.)]\s+(.*)$/)
        const content = kind === 'task' ? t?.[2] : kind === 'ul' ? (u && !t ? u[1] : null) : o && !u && !t ? o[1] : null
        if (content === null || content === undefined) break
        if (kind === 'task') items.push(`<li class="task${t[1] !== ' ' ? ' done' : ''}"><span class="box" aria-hidden="true"></span><span>${inline(t[2])}</span></li>`)
        else items.push(`<li>${inline(content)}</li>`)
        i++
      }
      out.push(kind === 'ol' ? `<ol>${items.join('')}</ol>` : `<ul class="${kind}">${items.join('')}</ul>`)
      continue
    }
    // 空行
    if (!line.trim()) {
      flushPara()
      i++
      continue
    }
    para.push(line.trim())
    i++
  }
  flushPara()
  return out.join('\n')
}

/** 搜索命中：返回 { hit, snippet(带 <mark>) } */
export function searchHighlight(note, query) {
  const q = String(query || '').trim()
  if (!q) return { hit: false, snippet: (note.content || '').split('\n')[0]?.slice(0, 80) || '' }
  const idxTitle = (note.title || '').toLowerCase().indexOf(q.toLowerCase())
  const content = note.content || ''
  const idx = content.toLowerCase().indexOf(q.toLowerCase())
  if (idxTitle < 0 && idx < 0) return { hit: false, snippet: content.split('\n')[0]?.slice(0, 80) || '' }
  const plain = (s) => escapeHtml(s)
  const title = idxTitle >= 0 ? `${plain((note.title || '').slice(0, idxTitle))}<mark>${plain((note.title || '').slice(idxTitle, idxTitle + q.length))}</mark>${plain((note.title || '').slice(idxTitle + q.length))}` : plain(note.title || '')
  let snippet = content.split('\n')[0]?.slice(0, 80) || ''
  if (idx >= 0) {
    const start = Math.max(0, idx - 20)
    snippet = `${start > 0 ? '…' : ''}${plain(content.slice(start, idx))}<mark>${plain(content.slice(idx, idx + q.length))}</mark>${plain(content.slice(idx + q.length, idx + q.length + 40))}`
  }
  return { hit: true, title, snippet }
}

/** 纯文本统计：字数（CJK 按字计）与行数 */
export function stats(text) {
  const s = String(text || '')
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length
  const words = (s.replace(/[\u4e00-\u9fff\u3040-\u30ff]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length
  return { chars: s.length, words: cjk + words, lines: s ? s.split('\n').length : 0 }
}

/** 插入辅助：包裹选区 / 行首前缀 / 块插入 */
export function transformWrap(text, selStart, selEnd, token) {
  const selected = text.slice(selStart, selEnd) || '文本'
  return { text: text.slice(0, selStart) + token + selected + token + text.slice(selEnd), caret: selStart + token.length + selected.length + token.length }
}
export function transformLinePrefix(text, selStart, token) {
  const lineStart = text.lastIndexOf('\n', selStart - 1) + 1
  return { text: text.slice(0, lineStart) + token + text.slice(lineStart), caret: selStart + token.length }
}
export function transformBlock(text, selStart, selEnd, block) {
  const selected = text.slice(selStart, selEnd)
  const insert = block.replace('```\n\n```', '```\n' + (selected || '代码') + '\n```').replace('|  |', '| ' + (selected || '') + ' |')
  return { text: text.slice(0, selStart) + insert + text.slice(selEnd), caret: selStart + insert.length }
}

/** 笔记数据归一化 */
export function normalizeNote(input, id) {
  if (!input || typeof input !== 'object') throw new Error('笔记数据格式不正确')
  const title = String(input.title ?? '').trim()
  if (!title) throw new Error('笔记缺少标题')
  const attachments = {}
  if (input.attachments && typeof input.attachments === 'object') {
    for (const [key, value] of Object.entries(input.attachments)) {
      if (typeof value === 'string') attachments[String(key).slice(0, 80)] = value.slice(0, 200)
    }
  }
  return {
    id: typeof id === 'string' && id ? id : typeof input.id === 'string' && input.id ? input.id : crypto.randomUUID(),
    title: title.slice(0, 120),
    group: String(input.group ?? '收件箱').trim().slice(0, 60) || '收件箱',
    content: String(input.content ?? '').slice(0, 512 * 1024),
    attachments,
    createdAt: Number(input.createdAt) || Date.now(),
    updatedAt: Number(input.updatedAt) || Date.now(),
  }
}

/** 内置模板 */
export const TEMPLATES = {
  meeting: {
    name: '会议记录',
    content: '# 会议记录\n\n- 时间：\n- 参会：\n\n## 议题\n\n1. \n\n## 结论\n\n- [ ] \n',
  },
  weekly: {
    name: '周报',
    content: '# 周报\n\n## 本周完成\n\n- [x] \n\n## 下周计划\n\n- [ ] \n\n## 风险与需要的支持\n\n- \n',
  },
  todo: {
    name: '待办',
    content: '# 待办\n\n- [ ] \n- [ ] \n',
  },
}

/** 导出 HTML 骨架 */
export function noteToHtml(title, content) {
  return `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width,initial-scale=1" />\n<title>${escapeHtml(title)}</title>\n<style>body{max-width:720px;margin:40px auto;padding:0 20px;font:15px/1.7 -apple-system,'PingFang SC',sans-serif;color:#24292f}pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto}code{font-family:ui-monospace,SFMono-Regular,monospace}table{border-collapse:collapse}th,td{border:1px solid #d0d7de;padding:6px 12px}img{max-width:100%}blockquote{border-left:4px solid #d0d7de;margin:0;padding:0 16px;color:#57606a}</style>\n</head>\n<body>\n${renderMarkdown(content)}\n</body>\n</html>\n`
}
