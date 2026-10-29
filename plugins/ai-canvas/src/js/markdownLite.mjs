/**
 * markdownLite — 轻量 Markdown 渲染（安全：先全文 HTML 转义，再按行组块）。
 * 覆盖 LLM 输出常见语法：标题、粗斜体、行内代码、围栏代码块、有序/无序列表、
 * 引用、链接（仅 http/https/mailto）、分隔线、段落换行。
 * 不引第三方库：插件页 CSP 严格且要控制体积，提示词预览不需要完整 CommonMark。
 */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ESCAPE_MAP[ch])
}

function safeHref(url) {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : '#'
}

/** 行内语法（作用于已转义文本） */
function inline(md) {
  let html = md
  html = html.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
    `<a href="${safeHref(url)}" target="_blank" rel="noreferrer noopener">${label}</a>`)
  return html
}

export function renderMarkdownLite(source) {
  const escaped = escapeHtml(source)
  const lines = escaped.split(/\r?\n/)
  const out = []
  let listType = null   // 'ul' | 'ol'
  let inCode = false
  let paragraph = []

  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null } }
  const flushParagraph = () => {
    if (paragraph.length) { out.push(`<p>${paragraph.join('<br>')}</p>`); paragraph = [] }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^```/.test(line.trim())) {
      flushParagraph(); closeList()
      if (inCode) { out.push('</code></pre>'); inCode = false }
      else { out.push('<pre><code>'); inCode = true }
      continue
    }
    if (inCode) { out.push(raw); continue }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) { flushParagraph(); closeList(); const level = heading[1].length + 2; out.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { flushParagraph(); closeList(); out.push('<hr>'); continue }
    const quote = /^&gt;\s?(.*)$/.exec(line)
    if (quote) { flushParagraph(); closeList(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue }
    const bullet = /^[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul' }
      out.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol' }
      out.push(`<li>${inline(ordered[1])}</li>`)
      continue
    }
    if (!line.trim()) { flushParagraph(); closeList(); continue }
    paragraph.push(inline(line.trim()))
  }
  if (inCode) out.push('</code></pre>')
  flushParagraph(); closeList()
  return out.join('')
}
