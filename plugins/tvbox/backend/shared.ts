/**
 * tvbox 后端共享设施：跨上下文归一 / 墙钟限时 / Convert 加解密 / HtmlDocument。
 * HtmlDocument 与 Convert 按 comic-house 同源实现移植（Venera 生态与 drpy 生态
 * 都依赖 pdfh/pdfa 一类 DOM 解析与 AES/MD5 工具）。
 */
import { createHash, createHmac, createCipheriv, createDecipheriv, privateDecrypt } from 'node:crypto'

/* ---------------- 通用 ---------------- */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
    promise.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))) })
  })
}

export function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

/** 沙箱 Map/普通对象的鸭子判断（跨上下文不能用 instanceof） */
export function isMapLike(v: unknown): v is Map<string, unknown> {
  return !!v && typeof v === 'object'
    && typeof (v as Map<string, unknown>).entries === 'function'
    && typeof (v as Map<string, unknown>).get === 'function'
    && typeof (v as Map<string, unknown>).size === 'number'
}

export function headersToPlain(input: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input || typeof input !== 'object') return out
  if (isMapLike(input)) {
    for (const [k, v] of input.entries()) out[String(k)] = String(v)
    return out
  }
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v !== null) out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  return out
}

/** 相对地址解析（站点 api 地址为基） */
export function resolveAgainst(baseUrl: string | undefined, url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  if (baseUrl) {
    try { return new URL(url, baseUrl).toString() } catch { /* fallthrough */ }
  }
  return url
}

/** 跨上下文值归一（vm 对象 → 纯 JSON，支持 Map/Set/字节数组） */
export function plain(value: unknown, depth = 0): any {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') return null
    if (typeof value === 'bigint') return String(value)
    return value
  }
  if (depth > 8) return null
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return { __bytes: Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString('base64') }
  }
  if (typeof (value as any).toElement === 'function') return String((value as any).text ?? '')
  if (isMapLike(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of value.entries()) out[String(k)] = plain(v, depth + 1)
    return out
  }
  if (typeof (value as any).size === 'number' && typeof (value as any).has === 'function' && typeof (value as any).add === 'function') {
    return [...(value as Set<unknown>)].map(v => plain(v, depth + 1))
  }
  if (Array.isArray(value)) return value.map(v => plain(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = plain(v, depth + 1)
  return out
}

/* ---------------- Convert API（drpy / spider 源通用） ---------------- */
function coerceBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (Array.isArray(input)) return Uint8Array.from(input as number[])
  if (typeof input === 'string') return new TextEncoder().encode(input)
  throw new Error('参数必须是 ArrayBuffer/字节数组')
}
function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
function normalizeHashName(name: string): string {
  const n = name.toLowerCase().replace(/-/g, '')
  return ['md5', 'sha1', 'sha256', 'sha512'].includes(n) ? n : 'md5'
}

export function makeConvertApi() {
  const digest = (algo: string) => (bytes: unknown): ArrayBuffer =>
    bytesToArrayBuffer(createHash(algo).update(coerceBytes(bytes)).digest())
  const keyIvDecipher = (mode: string, value: unknown, key: unknown, iv: unknown, isEncrypt: boolean): ArrayBuffer => {
    const k = coerceBytes(key)
    const algo = `aes-${k.byteLength * 8}-${mode}` as const
    const cipher = mode === 'ecb'
      ? (isEncrypt ? createCipheriv(algo, k, null) : createDecipheriv(algo, k, null))
      : (isEncrypt ? createCipheriv(algo, k, coerceBytes(iv)) : createDecipheriv(algo, k, coerceBytes(iv)))
    const data = Buffer.from(coerceBytes(value))
    return bytesToArrayBuffer(Buffer.concat([cipher.update(data), cipher.final()]))
  }
  return {
    encodeUtf8: (text: unknown): ArrayBuffer => bytesToArrayBuffer(new TextEncoder().encode(String(text ?? ''))),
    decodeUtf8: (bytes: unknown): string => new TextDecoder('utf-8').decode(coerceBytes(bytes)),
    encodeBase64: (bytes: unknown): string => Buffer.from(coerceBytes(bytes)).toString('base64'),
    decodeBase64: (text: unknown): ArrayBuffer => bytesToArrayBuffer(Buffer.from(String(text ?? ''), 'base64')),
    hexEncode: (bytes: unknown): string => Buffer.from(coerceBytes(bytes)).toString('hex'),
    md5: digest('md5'),
    sha1: digest('sha1'),
    sha256: digest('sha256'),
    sha512: digest('sha512'),
    hmac: (key: unknown, value: unknown, hash: unknown): ArrayBuffer => {
      const algo = normalizeHashName(String(hash ?? 'md5'))
      return bytesToArrayBuffer(createHmac(algo, coerceBytes(key)).update(coerceBytes(value)).digest())
    },
    hmacString: (key: unknown, value: unknown, hash: unknown): string => {
      const algo = normalizeHashName(String(hash ?? 'md5'))
      return createHmac(algo, coerceBytes(key)).update(coerceBytes(value)).digest('hex')
    },
    decryptAesEcb: (v: unknown, k: unknown) => keyIvDecipher('ecb', v, k, undefined, false),
    decryptAesCbc: (v: unknown, k: unknown, iv: unknown) => keyIvDecipher('cbc', v, k, iv, false),
    decryptAesCfb: (v: unknown, k: unknown, iv: unknown) => keyIvDecipher('cfb', v, k, iv, false),
    decryptAesOfb: (v: unknown, k: unknown) => keyIvDecipher('ofb', v, k, undefined, false),
    encryptAesEcb: (v: unknown, k: unknown) => keyIvDecipher('ecb', v, k, undefined, true),
    encryptAesCbc: (v: unknown, k: unknown, iv: unknown) => keyIvDecipher('cbc', v, k, iv, true),
    encryptAesCfb: (v: unknown, k: unknown, iv: unknown) => keyIvDecipher('cfb', v, k, iv, true),
    encryptAesOfb: (v: unknown, k: unknown) => keyIvDecipher('ofb', v, k, undefined, true),
    decryptRsa: (v: unknown, k: unknown): ArrayBuffer => {
      const keyText = String(k ?? '')
      const pem = keyText.includes('-----BEGIN')
        ? keyText
        : `-----BEGIN PRIVATE KEY-----\n${keyText}\n-----END PRIVATE KEY-----`
      return bytesToArrayBuffer(privateDecrypt(pem, Buffer.from(coerceBytes(v))))
    },
  }
}

/* ---------------- HtmlDocument（手写解析器 + 极简 CSS 选择器） ---------------- */
interface SimNode { type: 'element' | 'text' | 'comment'; name?: string; attrs?: Record<string, string>; children?: SimNode[]; text?: string }
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

function parseHtml(html: string): SimNode {
  const root: SimNode = { type: 'element', name: 'root', attrs: {}, children: [] }
  const stack: SimNode[] = [root]
  let i = 0
  const pushNode = (node: SimNode) => { const top = stack[stack.length - 1]; (top.children ??= []).push(node) }
  while (i < html.length) {
    if (html[i] !== '<') {
      const start = i
      while (i < html.length && html[i] !== '<') i++
      const t = html.slice(start, i)
      if (t) pushNode({ type: 'text', text: t })
      continue
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      const stop = end < 0 ? html.length : end + 3
      pushNode({ type: 'comment', text: html.slice(i, stop) })
      i = stop
      continue
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i)
      i = end < 0 ? html.length : end + 1
      continue
    }
    if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i)
      const name = html.slice(i + 2, end < 0 ? html.length : end).trim().toLowerCase()
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name) { stack.length = s; break }
      }
      i = end < 0 ? html.length : end + 1
      continue
    }
    const end = findTagEnd(html, i)
    const rawTag = html.slice(i + 1, end)
    i = end + 1
    const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rawTag)
    if (!m) continue
    const name = m[1].toLowerCase()
    const attrs = parseAttrs(rawTag.slice(m[1].length))
    const selfClosing = rawTag.endsWith('/') || VOID_TAGS.has(name)
    const node: SimNode = { type: 'element', name, attrs, children: [] }
    pushNode(node)
    if (!selfClosing) stack.push(node)
  }
  return root
}
function findTagEnd(html: string, start: number): number {
  let quote = ''
  for (let j = start + 1; j < html.length; j++) {
    const c = html[j]
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '>') return j
  }
  return html.length
}
function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.:-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '')
  }
  return attrs
}
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return _ as string } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)) } catch { return _ as string } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
}
function descendants(node: SimNode): SimNode[] {
  const out: SimNode[] = []
  const walk = (n: SimNode) => { for (const c of n.children ?? []) { if (c.type === 'element') { out.push(c); walk(c) } } }
  walk(node)
  return out
}
function selectMatches(root: SimNode, selector: string): SimNode[] {
  const groups = selector.split(',').map(s => s.trim()).filter(Boolean)
  const out: SimNode[] = []
  const seen = new Set<SimNode>()
  for (const group of groups) {
    const parts = group.split(/\s+/).filter(Boolean)
    out.push(...walkSelect(root, parts, 0, seen))
  }
  return out
}
function walkSelect(node: SimNode, parts: string[], index: number, seen: Set<SimNode>): SimNode[] {
  if (index >= parts.length) {
    if (node.type === 'element' && node.name !== 'root' && !seen.has(node)) { seen.add(node); return [node] }
    return []
  }
  const results: SimNode[] = []
  const candidates = node.type === 'element' && node.name !== 'root' ? [node, ...descendants(node)] : descendants(node)
  for (const cand of candidates) {
    if (matchesSimple(cand, parts[index])) results.push(...walkSelect(cand, parts, index + 1, seen))
  }
  return results
}
function matchesSimple(node: SimNode, part: string): boolean {
  if (node.type !== 'element') return false
  const segs: string[] = []
  const re = /([a-zA-Z][a-zA-Z0-9-]*|\.[a-zA-Z_][\w-]*|#[a-zA-Z_][\w-]*|\[[^\]]+\])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(part))) segs.push(m[1])
  if (!segs.length) return false
  for (const seg of segs) {
    if (seg.startsWith('.')) {
      if (!(node.attrs?.class ?? '').split(/\s+/).includes(seg.slice(1))) return false
    } else if (seg.startsWith('#')) {
      if (node.attrs?.id !== seg.slice(1)) return false
    } else if (seg.startsWith('[')) {
      const am = /^([a-zA-Z_:][\w:.]*)(?:([\^\$*~|]?=)("([^"]*)"|'([^']*)'|([^\]]*)))?$/.exec(seg.slice(1, -1))
      if (!am) return false
      const value = node.attrs?.[am[1].toLowerCase()]
      if (value === undefined) return false
      if (am[2]) {
        const expect = am[4] ?? am[5] ?? am[6] ?? ''
        switch (am[2]) {
          case '=': if (value !== expect) return false; break
          case '^=': if (!value.startsWith(expect)) return false; break
          case '$=': if (!value.endsWith(expect)) return false; break
          case '*=': if (!value.includes(expect)) return false; break
          case '~=': if (!value.split(/\s+/).includes(expect)) return false; break
          case '|=': if (value !== expect && !value.startsWith(expect + '-')) return false; break
        }
      }
    } else {
      if (node.name !== seg.toLowerCase()) return false
    }
  }
  return true
}
function nodeText(node: SimNode): string {
  if (node.type === 'text') return node.text ?? ''
  return (node.children ?? []).map(nodeText).join('')
}
function serializeNode(node: SimNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'comment') return `<!--${node.text ?? ''}-->`
  const attrs = Object.entries(node.attrs ?? {}).map(([k, v]) => v === '' ? k : `${k}="${v.replace(/"/g, '&quot;')}"`).join(' ')
  const inner = (node.children ?? []).map(serializeNode).join('')
  return attrs ? `<${node.name} ${attrs}>${inner}</${node.name}>` : `<${node.name}>${inner}</${node.name}>`
}

export class HtmlElement {
  constructor(private node: SimNode) {}
  get text(): string { return nodeText(this.node).trim() }
  get innerHTML(): string { return (this.node.children ?? []).map(serializeNode).join('') }
  get outerHTML(): string { return serializeNode(this.node) }
  get attributes(): Record<string, string> { return { ...(this.node.attrs ?? {}) } }
  get classNames(): string[] { return (this.node.attrs?.class ?? '').split(/\s+/).filter(Boolean) }
  get id(): string { return this.node.attrs?.id ?? '' }
  get localName(): string { return this.node.name ?? '' }
  get children(): HtmlElement[] { return (this.node.children ?? []).filter(c => c.type === 'element').map(c => new HtmlElement(c)) }
  get nodes(): Array<{ type: string; text: string; toElement(): HtmlElement | null }> {
    return (this.node.children ?? []).map(c => ({
      type: c.type,
      text: c.type === 'text' ? (c.text ?? '') : nodeText(c),
      toElement: () => c.type === 'element' ? new HtmlElement(c) : null,
    }))
  }
  get parent(): HtmlElement | null { return null }
  get previousElementSibling(): HtmlElement | null { return null }
  get nextElementSibling(): HtmlElement | null { return null }
  querySelector(selector: string): HtmlElement | null {
    const found = selectMatches(this.node, selector)
    return found.length ? new HtmlElement(found[0]) : null
  }
  querySelectorAll(selector: string): HtmlElement[] { return selectMatches(this.node, selector).map(n => new HtmlElement(n)) }
  getAttribute(name: string): string | null { return this.node.attrs?.[name.toLowerCase()] ?? null }
  dispose(): void { /* 解析器无原生资源 */ }
}
export class HtmlDocument {
  private root: SimNode
  constructor(html: string) { this.root = parseHtml(String(html ?? '')) }
  querySelector(selector: string): HtmlElement | null {
    const found = selectMatches(this.root, selector)
    return found.length ? new HtmlElement(found[0]) : null
  }
  querySelectorAll(selector: string): HtmlElement[] { return selectMatches(this.root, selector).map(n => new HtmlElement(n)) }
  getElementById(id: string): HtmlElement | null {
    const escaped = String(id).replace(/"/g, '\\"')
    const found = selectMatches(this.root, `[id="${escaped}"]`)
    return found.length ? new HtmlElement(found[0]) : null
  }
  dispose(): void { this.root = { type: 'element', name: 'root', attrs: {}, children: [] } }
}
