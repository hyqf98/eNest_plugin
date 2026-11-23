/**
 * 富文本净化：后端返回的介绍 HTML 在前端注入前再过一遍 DOMPurify（第二道防线）。
 * 若来源是 Markdown（修改器攻略等场景），先用 marked 转 HTML 再净化。
 *
 * 资源地址：后端已把外站图片 / 视频换成令牌或回环代理地址。这里再限定一次——
 * 图片 / 视频只能是 data URL 或本机回环代理，和宿主 CSP 的约束一致。
 * 视频属性按标签逐项限制（用 DOMPurify 的节点钩子，不用正则后处理）。
 */

import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: true })

/** 页面里允许出现的资源地址：data URL 与本机回环代理 */
export function isAllowedMediaUrl(url: string): boolean {
  return /^(?:data:(?:image|video|audio)\/|http:\/\/(?:127\.0\.0\.1|localhost):\d+\/)/i.test(url)
}

/** 每种标签允许保留的属性；未列出的标签用通用集合 */
const TAG_ATTRS: Record<string, string[]> = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  video: ['src', 'poster', 'controls', 'muted', 'loop', 'playsinline', 'preload', 'width', 'height'],
  source: ['src', 'type'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
}
const COMMON_ATTRS = ['class']

let hooksInstalled = false

/** 安装一次性钩子：按标签裁剪属性，并要求媒体地址只能是 data URL 或回环代理 */
function ensureHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    const tag = node.nodeName.toLowerCase()
    const allowed = TAG_ATTRS[tag] ?? COMMON_ATTRS
    if (!allowed.includes(data.attrName)) { data.keepAttr = false; return }
    // 布尔属性（controls / muted …）没有值
    const isUrl = data.attrName === 'src' || data.attrName === 'poster' || data.attrName === 'href'
    if (isUrl) {
      const value = String(data.attrValue ?? '')
      if (tag === 'a' && data.attrName === 'href') {
        // 链接只放行 http(s) 与 mailto，且强制新窗口打开
        if (!/^(?:https?:|mailto:)/i.test(value)) { data.keepAttr = false; return }
        return
      }
      if (value && !isAllowedMediaUrl(value)) { data.keepAttr = false; return }
    }
  })
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    const tag = data.tagName.toLowerCase()
    if (!(node instanceof Element)) return
    if (tag === 'video') {
      // 永远不带 autoplay：正文视频只由用户点击播放；强制显示控件且不预加载
      node.removeAttribute('autoplay')
      node.setAttribute('controls', '')
      if (!node.hasAttribute('preload')) node.setAttribute('preload', 'none')
    }
    if (tag === 'a') {
      node.setAttribute('rel', 'noopener noreferrer')
      node.setAttribute('target', '_blank')
    }
  })
}

/** 净化 HTML；已净化的内容重复净化是安全的 */
export function sanitizeHtml(html: string): string {
  if (!html) return ''
  ensureHooks()
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
    ALLOW_DATA_ATTR: false,
    ADD_TAGS: ['video', 'source'],
    ADD_ATTR: ['target', 'controls', 'muted', 'playsinline', 'preload', 'poster'],
    // 协议白名单：只放行 http(s)、mailto 与 data:；具体地址范围由上面的钩子按标签再收紧
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|data:|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  })
}

/** Markdown 转净化后的 HTML */
export function renderMarkdown(markdown: string): string {
  if (!markdown) return ''
  return sanitizeHtml(marked.parse(markdown, { async: false }))
}
