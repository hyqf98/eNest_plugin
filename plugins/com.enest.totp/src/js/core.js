/** TOTP 纯逻辑：base32、HMAC（WebCrypto）、RFC 6238 出码、otpauth 解析、AES-GCM 备份。 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** base32（RFC 4648）解码 → Uint8Array；容忍空格/连字符/小写与末尾 = */
export function base32Decode(input) {
  const clean = String(input ?? '').replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (!clean) throw new Error('secret 为空')
  if (!/^[A-Z2-7]+$/.test(clean)) throw new Error('secret 含非 base32 字符')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** bytes → base32（含 = 填充，对齐 RFC 4648） */
export function base32Encode(bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  while (out.length % 8 !== 0) out += '='
  return out
}

/** 8 字节大端计数器 */
function counterBytes(counter) {
  const buf = new Uint8Array(8)
  let rest = BigInt(counter)
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return buf
}

async function hmac(algorithm, keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes.slice().buffer, { name: 'HMAC', hash: algorithm }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, message.buffer)
  return new Uint8Array(sig)
}

/**
 * TOTP 出码（RFC 6238）。
 * @param secret base32 字符串
 * @param opts { digits, period, algorithm: 'SHA1'|'SHA256'|'SHA512', forTime: ms 时间戳（默认当前） }
 */
export async function totp(secret, { digits = 6, period = 30, algorithm = 'SHA1', forTime = Date.now(), counter = null } = {}) {
  const algoMap = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' }
  const hashName = algoMap[String(algorithm || 'SHA1').toUpperCase()]
  if (!hashName) throw new Error(`不支持的算法：${algorithm}`)
  const keyBytes = base32Decode(secret)
  const c = counter !== null ? counter : Math.floor(forTime / 1000 / period)
  const digest = await hmac(hashName, keyBytes, counterBytes(c))
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff)
  const code = (binary % 10 ** digits).toString().padStart(digits, '0')
  return code
}

/** 当前周期剩余秒数（1..period） */
export function remainingSeconds(now, period = 30) {
  const p = period > 0 ? period : 30
  return p - Math.floor((now / 1000) % p)
}

/** 周期起始时间戳（ms） */
export function periodStart(now, period = 30) {
  const p = period > 0 ? period : 30
  return Math.floor(now / 1000 / p) * p * 1000
}

/** otpauth://totp/Label?secret=..&issuer=.. 解析 */
export function parseOtpauth(uri) {
  let url
  try {
    url = new URL(String(uri ?? '').trim())
  } catch {
    throw new Error('不是有效的 otpauth 链接')
  }
  if (url.protocol !== 'otpauth:') throw new Error('不是有效的 otpauth 链接（需 otpauth://）')
  if (url.host.toLowerCase() !== 'totp') throw new Error('仅支持 totp 类型（不支持 hotp）')
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  let issuerParam = url.searchParams.get('issuer') || ''
  let account = label
  let issuerFromLabel = ''
  if (label.includes(':')) {
    const [prefix, ...rest] = label.split(':')
    issuerFromLabel = prefix.trim()
    account = rest.join(':').trim()
  }
  const issuer = (issuerParam || issuerFromLabel).trim()
  const secret = (url.searchParams.get('secret') || '').trim()
  if (!secret) throw new Error('链接缺少 secret')
  const digits = Number(url.searchParams.get('digits')) || 6
  const period = Number(url.searchParams.get('period')) || 30
  const algorithm = (url.searchParams.get('algorithm') || 'SHA1').toUpperCase()
  return {
    account: account || issuer || '账号',
    issuer,
    secret,
    digits: digits === 8 ? 8 : 6,
    period: period === 60 ? 60 : 30,
    algorithm: ['SHA1', 'SHA256', 'SHA512'].includes(algorithm) ? algorithm : 'SHA1',
  }
}

/** 条目 → otpauth uri（导出/迁移用） */
export function toOtpauth(entry) {
  const label = entry.issuer ? `${entry.issuer}:${entry.account}` : entry.account
  const params = new URLSearchParams({ secret: entry.secret })
  if (entry.issuer) params.set('issuer', entry.issuer)
  params.set('digits', String(entry.digits || 6))
  params.set('period', String(entry.period || 30))
  params.set('algorithm', entry.algorithm || 'SHA1')
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`
}

/** 条目归一化 */
export function normalizeEntry(input, id) {
  if (!input || typeof input !== 'object') throw new Error('条目数据格式不正确')
  const account = String(input.account ?? '').trim()
  const secret = String(input.secret ?? '').replace(/[\s-]/g, '')
  if (!account) throw new Error('条目缺少账号名')
  if (!secret) throw new Error('条目缺少 secret')
  base32Decode(secret) // 校验合法性
  return {
    id: typeof id === 'string' && id ? id : typeof input.id === 'string' && input.id ? input.id : crypto.randomUUID(),
    account: account.slice(0, 80),
    issuer: String(input.issuer ?? '').trim().slice(0, 60),
    secret,
    group: String(input.group ?? '').trim().slice(0, 40) || '默认',
    digits: Number(input.digits) === 8 ? 8 : 6,
    period: Number(input.period) === 60 ? 60 : 30,
    algorithm: ['SHA1', 'SHA256', 'SHA512'].includes(input.algorithm) ? input.algorithm : 'SHA1',
    sortOrder: Number(input.sortOrder) || 0,
    createdAt: Number(input.createdAt) || Date.now(),
  }
}

// —— 加密备份：PBKDF2-SHA256(210000) → AES-256-GCM ——//
const PBKDF2_ITERATIONS = 210000

function b64encode(bytes) {
  return btoa(String.fromCharCode(...bytes))
}
function b64decode(text) {
  const bin = atob(String(text))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 加密 payload（对象）→ 备份 JSON 字符串 */
export async function encryptBackup(payload, passphrase) {
  if (!passphrase || String(passphrase).length < 6) throw new Error('口令至少 6 位')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(passphrase)), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt.buffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.buffer }, key, plaintext))
  return JSON.stringify({ format: 'enest-totp-backup', version: 1, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: b64encode(salt), iv: b64encode(iv), data: b64encode(cipher) })
}

/** 解密备份 JSON 字符串 → payload */
export async function decryptBackup(text, passphrase) {
  let box
  try {
    box = JSON.parse(String(text))
  } catch {
    throw new Error('备份文件不是有效 JSON')
  }
  if (box?.format !== 'enest-totp-backup') throw new Error('不是验证器备份文件')
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(passphrase)), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64decode(box.salt).buffer, iterations: Number(box.iterations) || PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(box.iv).buffer }, key, b64decode(box.data).buffer)
    return JSON.parse(new TextDecoder().decode(plain))
  } catch {
    throw new Error('解密失败：口令错误或文件损坏')
  }
}
