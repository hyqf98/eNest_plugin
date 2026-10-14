/**
 * core.js — net-kit 纯逻辑核心（浏览器 / node 通用，无宿主依赖）
 * 导出：parseCurl、jsonPathQuery、jsonPathExists、buildUrl、
 *       envResolve、EnvStore、CodecRegistry、RingBuffer、formatHexDump、
 *       formatBytes、classifyStatus、netError（错误诊断映射）、SubJsonTree、
 *       SSE_FEEDER、HistoryStore、CollectionStore、wsUrlKind
 */

// ———— 通用工具 ————

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '-'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/** 状态码 → 徽章色系：2xx ok / 3xx neutral / 4xx·5xx danger / 其它 warn */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return 'ok'
  if (status >= 300 && status < 400) return 'neutral'
  if (status >= 400) return 'danger'
  return 'warn'
}

/** 宿主/网络错误 → 中文诊断（ECONNREFUSED 等映射） */
export function netError(message) {
  const m = String(message ?? '')
  if (/ENOTFOUND|EAI_AGAIN|host not found/i.test(m)) return '域名解析失败：主机名不存在或 DNS 不可用'
  if (/ECONNREFUSED|connection refused/i.test(m)) return '连接被拒绝：目标端口没有服务监听（或防火墙拦截）'
  if (/ETIMEDOUT|timeout|timed out/i.test(m)) return '连接超时：目标不可达或响应过慢，可尝试增大超时'
  if (/ECONNRESET|connection reset/i.test(m)) return '连接被对端重置：服务异常中断或协议不匹配'
  if (/EHOSTUNREACH|EHOST_DOWN/i.test(m)) return '主机不可达：路由或网络配置问题'
  if (/ENETUNREACH/i.test(m)) return '网络不可达：检查本机网络连接'
  if (/certificate|SSL|TLS|self-signed/i.test(m)) return 'TLS 握手失败：证书无效或协议不匹配'
  if (/rate limit|限速/i.test(m)) return '发送受限：宿主限速 1 MB/s，请降低发送频率或分片'
  if (/socket limit/i.test(m)) return '连接数达上限：单插件最多 8 条并发 socket，请先关闭部分连接'
  if (/only http/i.test(m)) return '协议被拒绝：HTTP 明文需 manifest 声明 allowInsecure（本插件已声明，请检查 URL）'
  if (/response body too large/i.test(m)) return '响应体超限：流式上限 32 MB，非流式 2 MB'
  if (/permission denied/i.test(m)) return '权限不足：请在插件设置或宿主中授权后重试'
  return m || '未知错误'
}

// ———— 环境变量 ————

export const DEFAULT_ENVS = {
  dev: { host: 'http://127.0.0.1:3000', token: '' },
  staging: { host: 'https://staging.example.com', token: '' },
  prod: { host: 'https://api.example.com', token: '' }
}

/** {{key}} 替换；未定义的变量保持原样并在 missing 中收集 */
export function envResolve(text, vars) {
  const missing = []
  const out = String(text ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    const v = vars?.[key]
    if (v === undefined || v === null) {
      missing.push(key)
      return _
    }
    return String(v)
  })
  return { text: out, missing }
}

/** 多环境 KV 存储（storage 持久化包装在调用方） */
export class EnvStore {
  constructor(data) {
    this.names = Object.keys(data ?? DEFAULT_ENVS)
    this.vars = data && Object.keys(data).length ? structuredClone(data) : structuredClone(DEFAULT_ENVS)
    this.current = this.names[0] ?? 'dev'
  }
  varsOf(name) {
    return this.vars[name] ?? {}
  }
  pick(name) {
    if (this.vars[name]) this.current = name
    return this.varsOf(this.current)
  }
  setVar(env, key, value) {
    if (!this.vars[env]) this.vars[env] = {}
    if (value === '') delete this.vars[env][key]
    else this.vars[env][key] = String(value)
    this.names = Object.keys(this.vars)
  }
  toJSON() {
    return this.vars
  }
  static from(json) {
    return new EnvStore(json && typeof json === 'object' ? json : null)
  }
}

/** URL + params → 完整 URL（已存在的 query 合并，params 覆盖同名） */
export function buildUrl(url, params) {
  const list = (params ?? []).filter((p) => p.enabled !== false && p.key)
  if (!list.length) return url
  try {
    const u = new URL(url)
    for (const p of list) u.searchParams.set(p.key, p.value ?? '')
    return u.toString()
  } catch {
    const sep = url.includes('?') ? '&' : '?'
    return url + sep + list.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? '')}`).join('&')
  }
}

// ———— curl 解析（支持 -X/-H/-d/--data-raw/--data/-F/-A/-e/-b/-u/-m/-k/@file） ————

/** shell 词法切分：处理单引号/双引号/转义，$'…' 按单引号语义 */
export function shellSplit(input) {
  const out = []
  let cur = ''
  let has = false
  let i = 0
  const s = String(input ?? '')
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ''; has = false }
      i++
      continue
    }
    if (c === "'") {
      has = true
      i++
      let j = s.indexOf("'", i)
      if (j < 0) { cur += s.slice(i); i = s.length; break }
      cur += s.slice(i, j)
      i = j + 1
      continue
    }
    if (c === '"') {
      has = true
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) {
          cur += s[i + 1] === '\n' ? '' : s[i + 1]
          i += 2
        } else {
          cur += s[i]
          i++
        }
      }
      i++
      continue
    }
    if (c === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '\n') { i += 2; continue } // 行续接：不产生 token
      has = true
      cur += s[i + 1]
      i += 2
      continue
    }
    if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting：按双引号转义语义处理
      has = true
      i += 2
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'" }
          cur += map[s[i + 1]] ?? s[i + 1]
          i += 2
        } else {
          cur += s[i]
          i++
        }
      }
      i++
      continue
    }
    has = true
    cur += c
    i++
  }
  if (has) out.push(cur)
  return out
}

const BOUNDARY_RE = /^-+[a-zA-Z0-9'"-]*\s*/

/**
 * 解析 curl 命令 → { method, url, headers, body, bodyKind, insecure, timeoutMs }
 * bodyKind: 'json' | 'form' | 'raw' | 'none'
 */export function parseCurl(input) {
  const text = String(input ?? '').trim()
  if (!/^curl(\s|$)/i.test(text)) throw new Error('不是 curl 命令：需以 curl 开头')
  const tokens = shellSplit(text)
  const req = { method: 'GET', url: '', headers: [], body: '', bodyKind: 'none', insecure: false, timeoutMs: 0 }
  let sawBody = false
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-X' || t === '--request') {
      req.method = (tokens[++i] ?? 'GET').toUpperCase()
    } else if (t === '-H' || t === '--header') {
      const raw = tokens[++i] ?? ''
      const idx = raw.indexOf(':')
      if (idx > 0) req.headers.push([raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()])
      else if (raw.endsWith(';')) req.headers.push([raw.slice(0, -1).trim(), ''])
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-ascii' || t === '--data-binary') {
      const v = tokens[++i] ?? ''
      if (v.startsWith('@')) throw new Error(`curl -d @file 引用了文件（${v.slice(1)}）：请手动把文件内容粘贴到 Body`)
      req.body = req.body ? req.body + '&' + v : v
      sawBody = true
    } else if (t === '--data-urlencode') {
      const v = tokens[++i] ?? ''
      req.body = req.body ? req.body + '&' + v : v
      sawBody = true
      req.headers.push(['content-type', 'application/x-www-form-urlencoded'])
    } else if (t === '-F' || t === '--form') {
      const v = tokens[++i] ?? ''
      if (v.startsWith('@')) throw new Error(`curl -F 引用了文件（${v.slice(1)}）：multipart 文件上传请在表单体中手动构造`)
      req.body = req.body ? req.body + '&' + v : v
      sawBody = true
      req.headers.push(['content-type', 'multipart/form-data'])
    } else if (t === '-A' || t === '--user-agent') {
      req.headers.push(['user-agent', tokens[++i] ?? ''])
    } else if (t === '-e' || t === '--referer') {
      req.headers.push(['referer', tokens[++i] ?? ''])
    } else if (t === '-b' || t === '--cookie') {
      req.headers.push(['cookie', tokens[++i] ?? ''])
    } else if (t === '-u' || t === '--user') {
      const cred = tokens[++i] ?? ''
      req.headers.push(['authorization', 'Basic ' + btoaCompat(cred)])
    } else if (t === '-m' || t === '--max-time') {
      req.timeoutMs = Math.round(Number(tokens[++i] ?? 0) * 1000) || 0
    } else if (t === '-k' || t === '--insecure') {
      req.insecure = true
    } else if (t === '-L' || t === '--location' || t === '-s' || t === '--silent' || t === '-S' || t === '--show-error' ||
               t === '-i' || t === '--include' || t === '-v' || t === '--verbose' || t === '-#' || t === '--progress-bar' ||
               t === '-G' || t === '--get' || t === '--compressed' || t === '-4' || t === '-6' || t === '--no-buffer') {
      // 已知无参开关：宿主 fetch 自行处理重定向；其余忽略
    } else if (t.startsWith('-')) {
      // 未知选项：若下一个 token 不以 - 开头则消费为参数，否则跳过
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith('-') && /^-[a-zA-Z]{2,}$/.test(t) === false && t.length <= 3) i++
    } else if (!req.url) {
      req.url = t
    }
  }
  if (!req.url) throw new Error('curl 中未找到 URL')
  if (sawBody) {
    req.method = req.method === 'GET' ? 'POST' : req.method
    const ct = req.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1]?.toLowerCase() ?? ''
    if (ct.includes('json')) req.bodyKind = 'json'
    else if (ct.includes('form')) req.bodyKind = 'form'
    else if (req.body.trim().startsWith('{') || req.body.trim().startsWith('[')) req.bodyKind = 'json'
    else req.bodyKind = 'raw'
  }
  if (!req.headers.some(([k]) => k.toLowerCase() === 'content-type') && req.bodyKind === 'json') {
    req.headers.push(['content-type', 'application/json'])
  }
  return req
}

function btoaCompat(str) {
  if (typeof btoa === 'function') return btoa(str)
  return Buffer.from(str, 'utf8').toString('base64')
}

/** 请求对象 → curl 文本（导出复制） */
export function toCurl({ method, url, headers, body }) {
  const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'` + String(s).replaceAll(`'`, `'\\''`) + `'`)
  const parts = ['curl', '-X', method]
  for (const [k, v] of headers ?? []) {
    if (k) parts.push('-H', q(`${k}: ${v ?? ''}`))
  }
  if (body && method !== 'GET' && method !== 'HEAD') parts.push('--data-raw', q(body))
  parts.push(q(url))
  return parts.join(' ')
}

// ———— JSONPath 轻量子集 ————

/**
 * 支持：$.a.b[0].c、$['a']、".." 递归下降、[*] 全部元素、$..key。
 * 不支持：过滤器表达式 / 切片 / 脚本。返回值数组（多条命中）。
 */
export function jsonPathQuery(obj, path) {
  const p = String(path ?? '').trim()
  if (!p.startsWith('$')) throw new Error('JSONPath 需以 $ 开头')
  const tokens = []
  let i = 1
  while (i < p.length) {
    const c = p[i]
    if (c === '.') {
      if (p[i + 1] === '.') {
        tokens.push({ op: 'descend' })
        i += 2
      } else i++
      continue
    }
    if (c === '[') {
      const end = p.indexOf(']', i)
      if (end < 0) throw new Error('JSONPath 括号未闭合')
      const inner = p.slice(i + 1, end).trim().replace(/^['"]|['"]$/g, '')
      if (inner === '*') tokens.push({ op: 'all' })
      else if (/^-?\d+$/.test(inner)) tokens.push({ op: 'index', value: Number(inner) })
      else tokens.push({ op: 'key', value: inner })
      i = end + 1
      continue
    }
    let j = i
    while (j < p.length && p[j] !== '.' && p[j] !== '[') j++
    const word = p.slice(i, j)
    if (word === '*') tokens.push({ op: 'all' })
    else if (word) tokens.push({ op: 'key', value: word })
    i = j
  }
  let current = [obj]
  for (const tok of tokens) {
    const next = []
    if (tok.op === 'key') {
      for (const node of current) {
        if (node && typeof node === 'object' && tok.value in node) next.push(node[tok.value])
      }
    } else if (tok.op === 'index') {
      for (const node of current) {
        if (Array.isArray(node)) {
          const idx = tok.value < 0 ? node.length + tok.value : tok.value
          if (idx >= 0 && idx < node.length) next.push(node[idx])
        }
      }
    } else if (tok.op === 'all') {
      for (const node of current) {
        if (Array.isArray(node)) next.push(...node)
        else if (node && typeof node === 'object') next.push(...Object.values(node))
      }
    } else if (tok.op === 'descend') {
      // 递归收集：当前层 + 全部后代（带后续 key 过滤）
      const collect = []
      const walk = (node) => {
        collect.push(node)
        if (node && typeof node === 'object') {
          for (const v of Object.values(node)) {
            if (v && typeof v === 'object') walk(v)
          }
        }
      }
      for (const node of current) walk(node)
      next.push(...collect)
    }
    current = next
  }
  return current
}

export function jsonPathExists(obj, path) {
  return jsonPathQuery(obj, path).length > 0
}

// ———— 断言 ————

export const ASSERT_TYPES = {
  statusEq: { label: '状态码等于', num: true },
  statusIn: { label: '状态码属于', num: false },
  maxMs: { label: '耗时不超过(ms)', num: true },
  jsonPathExists: { label: 'JSONPath 存在', num: false },
  jsonPathNotExists: { label: 'JSONPath 不存在', num: false },
  bodyContains: { label: 'Body 包含文本', num: false }
}

/**
 * 运行断言列表。ctx: { status, elapsedMs, bodyText, json }
 * 返回 [{ id, type, target, expected, pass, actual }]
 */
export function runAssertions(asserts, ctx) {
  return (asserts ?? []).map((a) => {
    let pass = false
    let actual = ''
    try {
      switch (a.type) {
        case 'statusEq':
          actual = String(ctx.status)
          pass = ctx.status === Number(a.expected)
          break
        case 'statusIn':
          actual = String(ctx.status)
          pass = String(a.expected ?? '').split(/[\s,，]+/).filter(Boolean).map(Number).includes(ctx.status)
          break
        case 'maxMs':
          actual = `${Math.round(ctx.elapsedMs)} ms`
          pass = ctx.elapsedMs <= Number(a.expected)
          break
        case 'jsonPathExists':
          actual = jsonPathExists(ctx.json, a.target) ? '存在' : '不存在'
          pass = ctx.json !== undefined && jsonPathExists(ctx.json, a.target)
          break
        case 'jsonPathNotExists':
          actual = jsonPathExists(ctx.json, a.target) ? '存在' : '不存在'
          pass = ctx.json === undefined || !jsonPathExists(ctx.json, a.target)
          break
        case 'bodyContains':
          actual = ctx.bodyText.includes(String(a.expected)) ? '包含' : '不包含'
          pass = ctx.bodyText.includes(String(a.expected))
          break
        default:
          actual = '未知断言类型'
      }
    } catch (err) {
      actual = err.message
    }
    return { ...a, pass, actual }
  })
}

// ———— TCP 字节缓冲与 hexdump ————

export const RX_BUFFER_MAX = 4 * 1024 * 1024

/** 环形丢弃缓冲：超上限时丢最旧数据并记录 dropped 字节数 */
export class RingBuffer {
  constructor(limit = RX_BUFFER_MAX) {
    this.limit = limit
    this.chunks = []
    this.length = 0
    this.dropped = 0
  }
  push(bytes) {
    this.chunks.push(bytes)
    this.length += bytes.length
    while (this.length > this.limit && this.chunks.length > 1) {
      const head = this.chunks[0]
      const over = this.length - this.limit
      if (head.length <= over) {
        this.chunks.shift()
        this.length -= head.length
        this.dropped += head.length
      } else {
        this.chunks[0] = head.subarray(over)
        this.length -= over
        this.dropped += over
      }
    }
    if (this.length > this.limit) {
      const over = this.length - this.limit
      this.chunks[0] = this.chunks[0].subarray(over)
      this.length = this.limit
      this.dropped += over
    }
  }
  /** 快照合并为单个 Uint8Array（最多 limit 字节） */
  snapshot() {
    const out = new Uint8Array(this.length)
    let off = 0
    for (const c of this.chunks) {
      out.set(c, off)
      off += c.length
    }
    return out
  }
  clear() {
    this.chunks = []
    this.length = 0
    this.dropped = 0
  }
}

/** bytes → hexdump 文本（偏移 + 16 字节 + ASCII；与 plugin-kit hexDump 同列宽） */
export function formatHexDump(bytes, { perLine = 16, offsetBase = 0 } = {}) {
  const lines = []
  for (let offset = 0; offset < bytes.length; offset += perLine) {
    const slice = bytes.subarray(offset, Math.min(offset + perLine, bytes.length))
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...slice].map((b) => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('')
    lines.push((offset + offsetBase).toString(16).padStart(8, '0') + '  ' + hex.padEnd(perLine * 3 - 1, ' ') + '  |' + ascii + '|')
  }
  return lines.join('\n') || '(空)'
}

// ———— 编解码策略注册表 ————

/** bytes → 文本（各内置策略）；解析失败抛 Error（UI 行内提示，不崩） */
function bytesToText(bytes, encoding) {
  return new TextDecoder(encoding, { fatal: true }).decode(bytes)
}

function tryJson(bytes) {
  const text = bytesToText(bytes, 'utf-8')
  const v = JSON.parse(text)
  return JSON.stringify(v, null, 2)
}

export const BUILTIN_DECODERS = [
  { id: 'hexdump', label: 'Hex Dump（16 进制）' },
  { id: 'ascii', label: 'ASCII（不可见 → .）' },
  { id: 'utf8', label: 'UTF-8 文本' },
  { id: 'utf16le', label: 'UTF-16LE 文本' },
  { id: 'json', label: 'JSON（尝试格式化）' },
  { id: 'base64', label: 'Base64' },
  { id: 'len-be2', label: '长度前缀帧 · 大端 2 字节' },
  { id: 'len-be4', label: '长度前缀帧 · 大端 4 字节' },
  { id: 'len-le2', label: '长度前缀帧 · 小端 2 字节' },
  { id: 'len-le4', label: '长度前缀帧 · 小端 4 字节' },
  { id: 'sep-crlf', label: '分隔符帧 · \\r\\n' },
  { id: 'sep-lf', label: '分隔符帧 · \\n' },
  { id: 'sep-null', label: '分隔符帧 · \\0' },
  { id: 'regex', label: '正则提取' }
]

/** 解析长度前缀帧（payload 可读文本则显示文本，否则 hex） */
function decodeLengthFrame(bytes, { bytes: n, little }) {
  if (bytes.length < n) throw new Error(`不足 ${n} 字节长度头`)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const len = little ? (n === 2 ? dv.getUint16(0, true) : dv.getUint32(0, true)) : (n === 2 ? dv.getUint16(0) : dv.getUint32(0))
  const body = bytes.subarray(n, Math.min(n + len, bytes.length))
  const head = `帧长 ${len} B（实际 ${body.length} B${body.length < len ? '，数据不足' : ''}）`
  let bodyText = ''
  try {
    bodyText = bytesToText(body, 'utf-8')
  } catch {
    bodyText = formatHexDump(body)
  }
  return head + '\n' + bodyText
}

function decodeSepFrame(bytes, sep) {
  const parts = []
  let start = 0
  for (let i = 0; i <= bytes.length - sep.length; i++) {
    let hit = true
    for (let j = 0; j < sep.length; j++) {
      if (bytes[i + j] !== sep[j]) { hit = false; break }
    }
    if (hit) {
      parts.push(bytes.subarray(start, i))
      i += sep.length - 1
      start = i + 1
    }
  }
  parts.push(bytes.subarray(start))
  const frames = parts.filter((p) => p.length > 0)
  if (!frames.length) return '(空)'
  return frames
    .map((f, idx) => {
      let text
      try {
        text = bytesToText(f, 'utf-8')
      } catch {
        text = formatHexDump(f)
      }
      return `#${idx + 1} ${f.length}B ${text}`
    })
    .join('\n')
}

function decodeRegex(bytes, pattern) {
  const re = new RegExp(pattern, 'gm')
  const text = bytesToText(bytes, 'utf-8')
  const hits = [...text.matchAll(re)].map((m) => (m[1] !== undefined ? m[1] : m[0]))
  if (!hits.length) throw new Error('正则无匹配')
  return hits.join('\n')
}

/** 应用解码策略；自定义策略用 new Function 在插件上下文运行，错误向上抛 */
export function applyDecoder(id, bytes, customs, { regexPattern = '' } = {}) {
  const custom = customs?.find((c) => c.id === id)
  if (custom) {
    const fn = compileDecoder(custom.code)
    const out = fn(bytes)
    if (typeof out !== 'string') throw new Error('自定义解码器必须返回字符串')
    return out
  }
  switch (id) {
    case 'hexdump': return formatHexDump(bytes)
    case 'ascii': return [...bytes].map((b) => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('')
    case 'utf8': return bytesToText(bytes, 'utf-8')
    case 'utf16le': return bytesToText(bytes, 'utf-16le')
    case 'json': return tryJson(bytes)
    case 'base64': return base64Encode(bytes)
    case 'len-be2': return decodeLengthFrame(bytes, { bytes: 2, little: false })
    case 'len-be4': return decodeLengthFrame(bytes, { bytes: 4, little: false })
    case 'len-le2': return decodeLengthFrame(bytes, { bytes: 2, little: true })
    case 'len-le4': return decodeLengthFrame(bytes, { bytes: 4, little: true })
    case 'sep-crlf': return decodeSepFrame(bytes, [13, 10])
    case 'sep-lf': return decodeSepFrame(bytes, [10])
    case 'sep-null': return decodeSepFrame(bytes, [0])
    case 'regex': return decodeRegex(bytes, regexPattern || '.+')
    default: throw new Error(`未知解码策略：${id}`)
  }
}

/** 编译自定义解码器：签名字节码 → 字符串。仅暴露 bytes 参数，出错抛可读信息 */
export function compileDecoder(code) {
  if (!code || !code.trim()) throw new Error('解码器代码为空')
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('bytes', `"use strict";\n${code}`)
    if (typeof fn !== 'function') throw new Error('不是函数')
    return fn
  } catch (err) {
    throw new Error(`解码器语法错误：${err.message}`)
  }
}

/** 测试自定义解码器：返回 { ok, output | error } */
export function testDecoder(code, sampleBytes) {
  try {
    const fn = compileDecoder(code)
    const out = fn(sampleBytes)
    if (typeof out !== 'string') return { ok: false, error: '必须返回字符串' }
    return { ok: true, output: out }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ———— 发送侧编码 ————

export function base64Encode(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoaCompat(bin)
}

export function base64Decode(text) {
  const clean = String(text ?? '').replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('不是合法 Base64')
  const bin = atobCompat(clean)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

function atobCompat(str) {
  if (typeof atob === 'function') return atob(str)
  return Buffer.from(str, 'base64').toString('binary')
}

export function hexDecode(text) {
  const clean = String(text ?? '').replace(/^0x/i, '').replace(/[\s,]/g, '')
  if (clean.length % 2 || !/^[0-9a-f]*$/i.test(clean)) throw new Error('Hex 需要偶数个十六进制字符')
  return Uint8Array.from(clean.match(/.{2}/g) ?? [], (v) => parseInt(v, 16))
}

/** 文本 → 字节（支持 {{var}} 已在调用方替换；\n \t \x41 \u0041 转义） */
export function unescapeSend(text) {
  return String(text ?? '').replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[nrt0\\])/g, (_, esc) => {
    if (esc.startsWith('x') || esc.startsWith('u')) return String.fromCharCode(parseInt(esc.slice(1), 16))
    if (esc === '\\') return '\\'
    return { n: '\n', r: '\r', t: '\t', 0: '\0' }[esc] ?? esc
  })
}

/**
 * 按发送策略把输入编码为字节。
 * kinds: text | hex | base64 | len-be2 | len-be4 | len-le2 | len-le4 | sep-crlf | sep-lf | sep-null
 */
export function encodeSend(input, kind) {
  const text = unescapeSend(input)
  switch (kind) {
    case 'text': return new TextEncoder().encode(text)
    case 'hex': return hexDecode(text)
    case 'base64': return base64Decode(text)
    case 'len-be2': case 'len-be4': case 'len-le2': case 'len-le4': {
      const n = kind.endsWith('2') ? 2 : 4
      const little = kind.endsWith('le2') || kind.endsWith('le4')
      const body = new TextEncoder().encode(text)
      const head = new Uint8Array(n)
      const dv = new DataView(head.buffer)
      if (n === 2) dv.setUint16(0, body.length, little)
      else dv.setUint32(0, body.length, little)
      const out = new Uint8Array(n + body.length)
      out.set(head, 0)
      out.set(body, n)
      return out
    }
    case 'sep-crlf': case 'sep-lf': case 'sep-null': {
      const body = new TextEncoder().encode(text)
      const sep = kind === 'sep-crlf' ? [13, 10] : kind === 'sep-lf' ? [10] : [0]
      const out = new Uint8Array(body.length + sep.length)
      out.set(body, 0)
      out.set(sep, body.length)
      return out
    }
    default: return new TextEncoder().encode(text)
  }
}

export const SEND_KINDS = [
  { id: 'text', label: '文本' },
  { id: 'hex', label: 'Hex 字面' },
  { id: 'base64', label: 'Base64' },
  { id: 'len-be2', label: '+长度头 大端2' },
  { id: 'len-be4', label: '+长度头 大端4' },
  { id: 'len-le2', label: '+长度头 小端2' },
  { id: 'len-le4', label: '+长度头 小端4' },
  { id: 'sep-crlf', label: '+\\r\\n 结尾' },
  { id: 'sep-lf', label: '+\\n 结尾' },
  { id: 'sep-null', label: '+\\0 结尾' }
]

// ———— SSE 文本进给（供插件把逐行 data 转成事件对象）———

export class SSE_FEEDER {
  constructor() {
    this.events = []
  }
  /** push 一行 data（宿主已剥 "data:" 前缀）；done 时收尾 */
  line(text) {
    this.events.push({ at: Date.now(), data: text })
    return this.events[this.events.length - 1]
  }
}

// ———— 历史 / 集合 ————

export const HISTORY_LIMIT = 50

export class HistoryStore {
  constructor(items = []) {
    this.items = Array.isArray(items) ? items.slice(0, HISTORY_LIMIT) : []
  }
  push(entry) {
    this.items.unshift({ ...entry, at: Date.now(), id: entry.id || `h-${Date.now()}-${Math.floor(Math.random() * 1e4)}` })
    if (this.items.length > HISTORY_LIMIT) this.items.length = HISTORY_LIMIT
    return this.items[0]
  }
  clear() {
    this.items = []
  }
  toJSON() {
    return this.items
  }
}

export class CollectionStore {
  constructor(data) {
    this.groups = Array.isArray(data?.groups) ? data.groups : []
    if (!this.groups.length) this.groups = [{ id: 'g-default', name: '默认分组', requests: [] }]
  }
  add(groupId, entry) {
    const g = this.groups.find((x) => x.id === groupId) ?? this.groups[0]
    g.requests.unshift({ ...entry, id: `r-${Date.now()}-${Math.floor(Math.random() * 1e4)}` })
    return g
  }
  remove(groupId, requestId) {
    const g = this.groups.find((x) => x.id === groupId)
    if (!g) return
    g.requests = g.requests.filter((r) => r.id !== requestId)
  }
  addGroup(name) {
    const g = { id: `g-${Date.now()}`, name: String(name || '新分组').trim() || '新分组', requests: [] }
    this.groups.push(g)
    return g
  }
  removeGroup(groupId) {
    if (this.groups.length <= 1) return
    this.groups = this.groups.filter((g) => g.id !== groupId)
  }
  toJSON() {
    return { groups: this.groups }
  }
}

// ———— WebSocket ————

/** 判定 ws url 形态：wss 直连 / ws 桥接不可行（宿主 ws 桥只服务已建 TCP socket） */
export function wsUrlKind(url) {
  const u = String(url ?? '').trim()
  if (/^wss:\/\//i.test(u)) return 'direct'
  if (/^ws:\/\//i.test(u)) return 'plain'
  if (/^ws:\/\/127\.0\.0\.1:\d+\/bridge/.test(u)) return 'bridge'
  return 'invalid'
}

/** JSON 树数据准备：深度裁剪 + 展开状态。返回节点 { key, type, value, children?, depth } 列表（扁平化） */
export function flattenJson(value, { maxDepth = 6, maxNodes = 2000 } = {}) {
  const rows = []
  let count = 0
  const walk = (v, key, depth, path) => {
    if (count >= maxNodes || depth > maxDepth) return
    count++
    const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
    if (type === 'object' || type === 'array') {
      const entries = type === 'array' ? v.map((x, i) => [String(i), x]) : Object.entries(v)
      rows.push({ key, type, preview: `${type === 'array' ? 'Array' : 'Object'}(${entries.length})`, depth, path, expandable: true })
      for (const [k, child] of entries) walk(child, k, depth + 1, `${path}.${k}`)
    } else {
      rows.push({ key, type, preview: type === 'string' ? `"${v}"` : String(v), depth, path, expandable: false })
    }
  }
  walk(value, '$', 0, '$')
  return rows
}

/** HTML 响应预览：提取 <table> 与标题结构 → 简表行 */
export function htmlPreview(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html')
  const title = doc.querySelector('title')?.textContent?.trim() ?? ''
  const heads = [...doc.querySelectorAll('h1,h2,h3')].slice(0, 10).map((h) => h.textContent.trim())
  const table = doc.querySelector('table')
  const rows = []
  if (table) {
    for (const tr of [...table.querySelectorAll('tr')].slice(0, 50)) {
      rows.push([...tr.querySelectorAll('th,td')].map((td) => td.textContent.trim()))
    }
  }
  return { title, heads, rows, hasTable: !!table }
}
