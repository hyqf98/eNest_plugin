/**
 * markdown v2 —— 文档资源提取（链接聚合面板用）。
 * 从 Markdown 源码里收集图片/链接，按类型分类：image / web / doc / file / anchor / mail / tel。
 * 先剔除代码块与行内代码避免误报；同一 URL 去重。
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)([?#]|$)/i
const DOC_EXT = /\.(md|markdown)([?#]|$)/i

export const KIND_LABEL = {
  image: '图片',
  web: '网页',
  doc: '文档',
  file: '文件',
  anchor: '锚点',
  mail: '邮件',
  tel: '电话',
}

/** 14px 线性图标（stroke 跟随 currentColor，无 emoji） */
export const KIND_ICON = {
  image: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><circle cx="5.5" cy="6.3" r="1.1"/><path d="M3.2 12 7 8.2l2.4 2.2 1.8-1.6 1.9 1.7"/></svg>',
  web: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4c-2 1.8-2 9.4 0 11.2M8 2.4c2 1.8 2 9.4 0 11.2M2.6 6.4h10.8M2.6 9.6h10.8"/></svg>',
  doc: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2.2h5.2L12.4 5v8.8H4z"/><path d="M6 8h4M6 10.4h4M9.2 2.2V5h3.2"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2.2h5.2L12.4 5v8.8H4z"/><path d="M9.2 2.2V5h3.2"/></svg>',
  anchor: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.4 9.6 3.8 12.2a2.3 2.3 0 0 1-3.2-3.2L3.2 6.4M9.6 6.4l2.6-2.6a2.3 2.3 0 0 1 3.2 3.2l-2.6 2.6M6.2 9.8 9.8 6.2"/></svg>',
  mail: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.8" y="3.6" width="12.4" height="8.8" rx="1.6"/><path d="m3 5 5 3.6L13 5"/></svg>',
  tel: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2.6h2.4l1.2 3-1.5 1a9 9 0 0 0 3.3 3.3l1-1.5 3 1.2V12a1.6 1.6 0 0 1-1.8 1.6C6.2 13.1 2.9 9.8 2.4 4.4A1.6 1.6 0 0 1 3 2.6Z"/></svg>',
}

export function detectKind(url, fromMdImage = false) {
  if (fromMdImage) return 'image'
  if (/^data:/i.test(url)) return 'image'
  if (/^mailto:/i.test(url)) return 'mail'
  if (/^tel:/i.test(url)) return 'tel'
  if (url.startsWith('#')) return 'anchor'
  if (/^https?:\/\//i.test(url)) return IMAGE_EXT.test(url) ? 'image' : 'web'
  if (IMAGE_EXT.test(url)) return 'image'
  if (DOC_EXT.test(url)) return 'doc'
  return 'file'
}

function decodeSafe(url) {
  try { return decodeURIComponent(url) } catch { return url }
}

export function titleFor(url, label) {
  if (label) return label
  if (url.startsWith('#')) return decodeSafe(url.slice(1))
  if (/^https?:/i.test(url)) {
    try {
      const u = new URL(url)
      const seg = u.pathname.replace(/^\//, '')
      return seg ? `${u.hostname}/${seg.split('/').pop()}` : u.hostname
    } catch { return url }
  }
  const name = url.split(/[\\/]/).filter(Boolean).pop()
  return name || url
}

export function isImageExt(url) {
  return IMAGE_EXT.test(url)
}

/**
 * 提取文档全部资源引用。
 * 返回 [{ kind, url, label, raw }]，按出现顺序、URL 去重。
 */
export function extractResources(text) {
  // 剔除围栏代码块与行内代码
  const cleaned = String(text ?? '')
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '')
    .replace(/`[^`\n]*`/g, '')
  const items = []
  const seen = new Set()
  const push = (kind, url, label) => {
    if (!url || seen.has(url)) return
    seen.add(url)
    items.push({ kind, url, label })
  }
  // [text](url) / ![alt](url)
  const mdRe = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let m
  while ((m = mdRe.exec(cleaned))) {
    push(detectKind(m[3], m[1] === '!'), m[3], m[2])
  }
  // 裸 URL（seen 去重兜底 markdown 链接里已捕获的）
  const bareRe = /https?:\/\/[^\s<>()\[\]"']+/g
  while ((m = bareRe.exec(cleaned))) {
    const url = m[0].replace(/[.,;:!?]+$/, '')
    push(detectKind(url), url, '')
  }
  return items
}
