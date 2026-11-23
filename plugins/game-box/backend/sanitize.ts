/**
 * 第三方 HTML 的白名单净化（用于游戏介绍、修改器说明等从站点抓来的正文）。
 *
 * 为什么不用 DOMPurify：后端是 Node，仓库里的 DOM 实现是 linkedom，实测 DOMPurify 在它上面
 * `isSupported` 为假并**原样返回未净化内容**（连 onerror 都挡不住）。正则净化也不可靠：
 * 实体编码、协议里夹空白等变体绕得过去。
 *
 * 这里用解析器（htmlparser2）把 HTML 还原成事件流，再按白名单**重建**：
 * 不在白名单上的标签、属性、协议一律丢弃，而不是去匹配"坏模式"。
 */

import { Parser } from 'htmlparser2'
import { escapeText, escapeAttribute } from './escape.ts'

/** 允许的标签及其允许的属性；href/src 另有协议白名单 */
const ALLOWED: Record<string, string[]> = {
  a: ['href', 'title'],
  abbr: ['title'], b: [], blockquote: [], br: [], code: [], dd: [], del: [], div: [], dl: [], dt: [], em: [],
  figcaption: [], figure: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], hr: [], i: [],
  img: ['src', 'alt', 'width', 'height'],
  // 正文里的短视频（Steam 商店的动图式演示）：地址走令牌改写，属性只留播放行为相关的几个
  video: ['src', 'poster', 'controls', 'muted', 'loop', 'playsinline', 'preload', 'width', 'height'],
  source: ['src', 'type'],
  ins: [], kbd: [], li: [], mark: [], ol: [], p: [], pre: [], q: [], s: [], small: [], span: [], strong: [], sub: [], summary: [],
  sup: [], table: [], tbody: [], td: [], tfoot: [], th: ['colspan', 'rowspan'], thead: [], tr: [], u: [], ul: [], details: [],
}

/** 允许的 class：站点正文里的 Steam 商店样式类，用于排版；其它 class 一律丢弃 */
const ALLOWED_CLASSES = new Set(['bb_tag', 'bb_paragraph', 'bb_ul', 'bb_li', 'bb_h1', 'bb_h2', 'bb_h3', 'bb_ulli', 'bb_ol', 'bb_oli', 'bb_img', 'bb_img_ctn'])

const VOID_TAGS = new Set(['br', 'hr', 'img', 'source'])
/** 这些标签上的属性只是开关（存在即生效），不带值 */
const BOOLEAN_ATTRS = new Set(['controls', 'muted', 'loop', 'playsinline'])
/** source 的 type 只接受视频/音频 MIME，可带 RFC 6381 的 codecs 参数；返回规范化后的值，不合法返回空串 */
const SAFE_MEDIA_TYPE = /^(?:video|audio)\/[a-z0-9][a-z0-9.+-]*$/i
/** codecs 参数：带引号的逗号列表，或不带引号的单个 codec 名（站点实际写的是 codecs=vp9） */
const CODECS_QUOTED = /^codecs\s*=\s*(?:"([a-zA-Z0-9.,\-_ ()]{1,120})"|'([a-zA-Z0-9.,\-_ ()]{1,120})')$/i
const CODECS_BARE = /^codecs\s*=\s*([a-zA-Z0-9.\-_]{1,40})$/i
function normalizeSourceType(raw: string): string {
  const value = decodeEntities(raw).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const semicolon = value.indexOf(';')
  const mime = (semicolon < 0 ? value : value.slice(0, semicolon)).trim().toLowerCase()
  if (!SAFE_MEDIA_TYPE.test(mime)) return ''
  if (semicolon < 0) return mime
  const params = value.slice(semicolon + 1).trim()
  if (params === '') return mime
  const quoted = CODECS_QUOTED.exec(params)
  if (quoted) return `${mime}; codecs="${(quoted[1] ?? quoted[2] ?? '').trim()}"`
  const bare = CODECS_BARE.exec(params)
  if (bare) return `${mime}; codecs="${bare[1]}"`
  return ''
}
/** preload 只接受标准关键字 */
const SAFE_PRELOAD = /^(?:none|metadata|auto)$/i
/** 链接与资源只允许这些协议（相对地址也允许） */
const SAFE_PROTOCOL = /^(?:https?:|mailto:)/i
/** 属性名只接受小写字母与连字符，长度受限 */
const ATTR_NAME = /^[a-z][a-z0-9-]{0,30}$/

/** 解码数值/命名实体后再判断协议：浏览器会把 &#106;avascript: 当成 javascript: */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&colon;/gi, ':').replace(/&tab;/gi, '\t').replace(/&newline;/gi, '\n').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD'
  try { return String.fromCodePoint(code) } catch { return '\uFFFD' }
}

function safeUrl(raw: string): string | null {
  // 先解实体，再去掉所有空白：协议里夹的 tab / 换行浏览器会忽略，判断时也必须忽略
  const compact = decodeEntities(raw).replace(/[\u0000-\u0020\u007f\u00a0\u2028\u2029]/g, '')
  if (!compact) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(compact)) return SAFE_PROTOCOL.test(compact) ? compact : null
  // 无协议：相对地址可用，但不能以 // 开头指向任意外站协议（//evil.test 在 https 页面等同 https://，允许）
  return compact
}

/** 把一个 URL 换成媒体令牌；不是 http(s) 的绝对地址返回 null */
export type ImageTokenResolver = (url: string) => string | null

export interface SanitizeOptions {
  /** 给 img 的 src / video 的 poster 生成令牌；不传则图片只保留 alt 文本（src 被丢弃） */
  imageToken?: ImageTokenResolver
  /** 给 video / source 的 src 生成令牌；不传则视频整个标签被丢弃 */
  videoToken?: ImageTokenResolver
  /** 链接地址改写（例如加跳转前缀）；返回 null 表示丢弃 href */
  linkHref?: (url: string) => string | null
}

/**
 * 按白名单重建 HTML。输出里的文本与属性值全部重新转义，
 * 因此即使输入带有畸形标签也不会在输出里"复活"。
 */
export function sanitizeHtml(input: string, options: SanitizeOptions = {}): string {
  const out: string[] = []
  const openStack: string[] = []
  // 正在输出的 <video>：记下开标签在输出里的位置，闭合时若整段没有地址就撤掉
  const videoStack: Array<{ start: number; hasSource: boolean }> = []
  let skippedDepth = 0
  let skippedTag = ''
  let finished = false

  const closeSelfAndAncestors = (name: string): void => {
    const index = openStack.lastIndexOf(name)
    if (index < 0) return
    for (let i = openStack.length - 1; i >= index; i--) out.push(`</${openStack[i]}>`)
    openStack.length = index
  }

  /** 开始跳过一个容器：直到它的同名闭合标签为止，里面的内容一律不要 */
  const beginSkip = (tag: string): void => { skippedDepth = 1; skippedTag = tag }

  const parser = new Parser({
    onopentag(name, attributes) {
      if (finished) return
      const tag = name.toLowerCase()
      if (skippedDepth > 0) {
        // 被丢弃的容器里：遇到同名容器深度加一（对应后面多出来的一个同名闭合标签），其余一律不要
        if (tag === skippedTag && !VOID_TAGS.has(tag)) skippedDepth++
        return
      }
      if (!Object.hasOwn(ALLOWED, tag)) {
        // 不在白名单：非 void 标签当作需要跳过内容的容器
        if (!VOID_TAGS.has(tag)) beginSkip(tag)
        return
      }
      const allowedAttrs = ALLOWED[tag]
      // video / source 只有在提供了视频令牌解析器时才放行；否则整个标签连同内容一起丢弃
      if ((tag === 'video' || tag === 'source') && !options.videoToken) {
        if (!VOID_TAGS.has(tag)) beginSkip(tag)
        return
      }
      const parts: string[] = [tag]
      // source / video 是否拿到了可播放地址（决定这个标签最终输不输出）；source 的 type 是否合法
      let hasSource = false
      let typeRejected = false
      for (const [rawName, rawValue] of Object.entries(attributes)) {
        const attr = rawName.toLowerCase()
        if (!ATTR_NAME.test(attr) || !allowedAttrs.includes(attr)) continue
        const value = Array.isArray(rawValue) ? rawValue.join(' ') : String(rawValue ?? '')
        if (attr === 'href' || attr === 'src' || attr === 'poster') {
          const url = safeUrl(value)
          if (!url) continue
          if (attr === 'href') {
            const href = options.linkHref ? options.linkHref(url) : url
            if (!href) continue
            parts.push(`href="${escapeAttribute(href)}"`, 'rel="noopener noreferrer" target="_blank"')
            continue
          }
          // 资源地址一律换成令牌：img 与 video 的 poster 用图片令牌，video / source 的 src 用视频令牌。
          // 只有 http(s) 绝对地址才能被换成令牌；其余（相对地址、其它协议）整个属性丢弃，
          // 没有 src 的 <video>/<source> 不会被渲染成任何东西，也拉不到任何外部资源。
          const isVideoSource = attr === 'src' && (tag === 'video' || tag === 'source')
          const resolver = isVideoSource ? options.videoToken : options.imageToken
          const token = /^https?:\/\//i.test(url) && resolver ? (resolver(url) ?? null) : null
          if (!token) continue
          if (isVideoSource) hasSource = true
          parts.push(`${attr}="${escapeAttribute(token)}"`)
          continue
        }
        if (attr === 'width' || attr === 'height') {
          if (/^\d{1,5}$/.test(value.trim())) parts.push(`${attr}="${value.trim()}"`)
          continue
        }
        if (attr === 'colspan' || attr === 'rowspan') {
          if (/^[1-9]\d{0,2}$/.test(value.trim())) parts.push(`${attr}="${value.trim()}"`)
          continue
        }
        if (BOOLEAN_ATTRS.has(attr)) { parts.push(attr); continue }
        if (attr === 'type' && tag === 'source') {
          // MIME 后面可以带 RFC 6381 的 codecs 参数；其余一律视为不合法（合法与否在最后决定整个 source 输不输出）
          const mime = normalizeSourceType(value)
          // 值里可能带引号（codecs="…"），必须转义后才能放进双引号属性
          if (mime) parts.push(`type="${escapeAttribute(mime)}"`)
          else typeRejected = true
          continue
        }
        if (attr === 'preload') {
          if (SAFE_PRELOAD.test(value.trim())) parts.push(`preload="${value.trim().toLowerCase()}"`)
          continue
        }
        parts.push(`${attr}="${escapeAttribute(decodeEntities(value).slice(0, 300))}"`)
      }
      // <source> 没有地址就不输出；<video> 先照常输出并压栈，等它的子 <source> 提供地址——
      // 站点正文的写法就是 <video><source webm><source mp4></video>。闭合时若整段里一个可用地址都没有再撤掉。
      if (tag === 'source' && (!hasSource || typeRejected)) return
      // video 固定带 controls、默认不预加载，且不带 autoplay：正文里的视频只由用户点击播放
      const emitted = tag === 'video' ? parts.filter(part => part !== 'autoplay' && !part.startsWith('preload=')).concat(['controls', 'preload="none"']) : parts
      // class 只放行排版用的白名单类名
      const rawClass = Array.isArray(attributes.class) ? attributes.class.join(' ') : String(attributes.class ?? '')
      const classes = rawClass.split(/\s+/).filter(name => ALLOWED_CLASSES.has(name))
      if (classes.length) out.push(`<${emitted.join(' ')} class="${classes.join(' ')}">`)
      else out.push(`<${emitted.join(' ')}>`)
      if (!VOID_TAGS.has(tag)) {
        openStack.push(tag)
        if (tag === 'video') videoStack.push({ start: out.length - 1, hasSource })
      }
      if (tag === 'source' && videoStack.length) videoStack[videoStack.length - 1].hasSource = true
    },
    onclosetag(name) {
      if (finished) return
      const tag = name.toLowerCase()
      if (skippedDepth > 0) {
        // 只在被跳过容器的同名闭合标签上解除跳过；同名嵌套按深度对应。
        // 其它标签（包括 void 子标签的闭合事件）不能解除跳过，否则里面的文字会漏出来。
        if (tag === skippedTag) skippedDepth--
        return
      }
      if (!Object.hasOwn(ALLOWED, tag) || VOID_TAGS.has(tag)) return
      if (tag === 'video' && videoStack.length) {
        // 整个 video 里没有任何可播放地址：把开标签到现在为止的输出整段撤掉，不留空控件
        const frame = videoStack.pop()
        if (frame && !frame.hasSource) {
          out.length = frame.start
          const index = openStack.lastIndexOf('video')
          if (index >= 0) openStack.splice(index)
          return
        }
      }
      closeSelfAndAncestors(tag)
    },
    ontext(text) {
      if (finished || skippedDepth > 0) return
      out.push(escapeText(text))
    },
    oncomment() { /* 注释一律丢弃 */ },
    onprocessinginstruction() { /* 处理指令一律丢弃 */ },
    onerror() { finished = true },
  }, {
    // 让解析器把实体解码成字符，再由我们统一重新转义一次（输出里只会有一层转义，不会出现 &amp;lt;）
    decodeEntities: true,
    recognizeSelfClosing: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
    xmlMode: false,
  })

  // 输入里不让出现 </textarea>/<!-- 之类的"解析器分歧"源头之外的东西：统一去掉 NUL
  parser.write(String(input ?? '').replace(/\u0000/g, '').slice(0, 2_000_000))
  parser.end()
  // 关掉所有未闭合的标签，保证输出是良构的
  for (let i = openStack.length - 1; i >= 0; i--) out.push(`</${openStack[i]}>`)
  return out.join('')
}

/** 去掉所有标签，只留纯文本（用于列表摘要等场景）；块级边界补一个空格，脚本与样式的内容不要 */
export function stripToText(input: string): string {
  let text = ''
  let skipDepth = 0
  const BLOCK = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th', 'table', 'blockquote', 'pre', 'hr', 'figcaption', 'figure', 'dl', 'dt', 'dd'])
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed'])
  const space = () => { if (text && !/\s$/.test(text)) text += ' ' }
  const parser = new Parser({
    onopentag(name) { if (SKIP.has(name)) skipDepth++; else if (skipDepth === 0 && BLOCK.has(name)) space() },
    onclosetag(name) { if (SKIP.has(name)) { skipDepth = Math.max(0, skipDepth - 1) } else if (skipDepth === 0 && BLOCK.has(name)) space() },
    ontext(value) { if (skipDepth === 0) text += value },
  }, { decodeEntities: true })
  parser.write(String(input ?? '').replace(/\u0000/g, '').slice(0, 500_000))
  parser.end()
  return text.replace(/\s+/g, ' ').trim()
}
