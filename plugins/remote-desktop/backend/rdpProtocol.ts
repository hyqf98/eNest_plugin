import { createHash } from 'node:crypto'
import type * as tls from 'node:tls'

// ── RDCleanPath ASN.1 DER（协议常量；移植自 electerm/ironrdp-wasm rdp-proxy.js，MIT）──
/** RDCleanPath 协议版本号：3389 + 1 */
const RDP_CLEAN_PATH_VERSION = 3390
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_CERTIFICATES = 64
const MAX_CERTIFICATE_BYTES = 1024 * 1024
const TAG_SEQUENCE = 0x30
const TAG_INTEGER = 0x02
const TAG_OCTET_STRING = 0x04
const TAG_UTF8STRING = 0x0c
/** context-specific EXPLICIT tag [n]（constructed） */
const TAG_CTX = (n: number): number => 0xa0 + n

function derEncodeLength(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) throw new Error('invalid DER length')
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let temp = length
  while (temp > 0) {
    bytes.unshift(temp & 0xff)
    temp = Math.floor(temp / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derWrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derEncodeLength(content.length), content])
}

function derEncodeInteger(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) throw new Error('invalid DER integer')
  if (value === 0) return derWrap(TAG_INTEGER, Buffer.from([0]))
  const bytes: number[] = []
  let temp = value
  while (temp > 0) {
    bytes.unshift(temp & 0xff)
    temp = Math.floor(temp / 256)
  }
  if (bytes[0] & 0x80) bytes.unshift(0)
  return derWrap(TAG_INTEGER, Buffer.from(bytes))
}

function derEncodeUtf8String(str: string): Buffer {
  return derWrap(TAG_UTF8STRING, Buffer.from(str, 'utf-8'))
}

function derEncodeOctetString(buf: Buffer): Buffer {
  return derWrap(TAG_OCTET_STRING, buf)
}

function derWrapContext(tagNum: number, content: Buffer): Buffer {
  return derWrap(TAG_CTX(tagNum), content)
}

interface DerTlv { tag: number; value: Buffer; totalLength: number }

function derDecodeLength(buf: Buffer, offset: number): { length: number; bytesRead: number } {
  if (offset >= buf.length) throw new Error('invalid DER length')
  const first = buf[offset]
  if (first < 0x80) return { length: first, bytesRead: 1 }
  const numBytes = first & 0x7f
  if (!numBytes || numBytes > 4 || offset + 1 + numBytes > buf.length) throw new Error('invalid DER length')
  if (buf[offset + 1] === 0) throw new Error('non-canonical DER length')
  let length = 0
  for (let i = 0; i < numBytes; i++) length = length * 256 + buf[offset + 1 + i]
  if (length < 0x80) throw new Error('non-canonical DER length')
  return { length, bytesRead: 1 + numBytes }
}

function derDecodeTLV(buf: Buffer, offset: number): DerTlv {
  if (offset < 0 || offset >= buf.length) throw new Error('missing DER value')
  const tag = buf[offset]
  const { length, bytesRead } = derDecodeLength(buf, offset + 1)
  const headerLen = 1 + bytesRead
  if (offset + headerLen + length > buf.length) throw new Error('truncated DER value')
  return { tag, value: buf.subarray(offset + headerLen, offset + headerLen + length), totalLength: headerLen + length }
}

function derDecodeInteger(buf: Buffer): number {
  if (!buf.length || buf.length > 4 || (buf[0] & 0x80)) throw new Error('invalid DER integer')
  if (buf.length > 1 && buf[0] === 0 && !(buf[1] & 0x80)) throw new Error('non-canonical DER integer')
  let val = 0
  for (let i = 0; i < buf.length; i++) val = val * 256 + buf[i]
  return val
}

function derDecodeExplicit(child: DerTlv, innerTag: number): Buffer {
  const inner = derDecodeTLV(child.value, 0)
  if (inner.tag !== innerTag) throw new Error('RDCleanPath: unexpected inner DER tag')
  if (inner.totalLength !== child.value.length) throw new Error('RDCleanPath: trailing explicit DER data')
  return inner.value
}

function derDecodeUtf8(buf: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf) }
  catch { throw new Error('RDCleanPath: invalid UTF8String') }
}

export function validateX224Pdu(data: Buffer, expectedType?: 'request' | 'confirm'): void {
  if (!Buffer.isBuffer(data) || data.length < 11 || data.length > 0xffff) throw new Error('RDCleanPath: invalid X.224 TPKT size')
  if (data[0] !== 3 || data[1] !== 0 || data.readUInt16BE(2) !== data.length) throw new Error('RDCleanPath: invalid X.224 TPKT header')
  if (data[4] < 6 || data[4] > data.length - 5) throw new Error('RDCleanPath: invalid X.224 length indicator')
  const type = data[5]
  if ((expectedType === 'request' && type !== 0xe0) || (expectedType === 'confirm' && type !== 0xd0)
    || (type !== 0xe0 && type !== 0xd0)) throw new Error('RDCleanPath: invalid X.224 connection type')
}

export interface RdpCleanPathRequest {
  destination: string
  proxyAuth: string
  x224ConnectionRequest: Buffer
  preconnectionBlob?: string
}

/**
 * 解析 RDCleanPath Request PDU（DER）。
 * 结构：SEQUENCE { [0] version INTEGER, [2] destination UTF8String,
 *   [3] proxy_auth UTF8String?, [5] preconnection_blob UTF8String?,
 *   [6] x224_connection_pdu OCTET STRING }（仅带 ? 字段可省略）
 */
export function parseRdpCleanPathRequest(data: Buffer): RdpCleanPathRequest {
  if (!Buffer.isBuffer(data)) throw new Error('RDCleanPath: expected Buffer')
  if (data.length > MAX_REQUEST_BYTES) throw new Error('RDCleanPath: request exceeds 64 KiB')
  const buf = data
  const outer = derDecodeTLV(buf, 0)
  if (outer.totalLength !== buf.length) throw new Error('trailing DER data')
  if (outer.tag !== TAG_SEQUENCE) {
    throw new Error(`RDCleanPath: expected SEQUENCE (0x30), got 0x${outer.tag.toString(16)}`)
  }
  let version: number | null = null
  let destination: string | null = null
  let proxyAuth = ''
  let x224ConnectionRequest: Buffer | null = null
  let preconnectionBlob: string | undefined
  const seen = new Set<number>()
  let offset = 0
  let previousTag = -1
  while (offset < outer.value.length) {
    const child = derDecodeTLV(outer.value, offset)
    offset += child.totalLength
    if (seen.has(child.tag)) throw new Error('RDCleanPath: duplicate field')
    if (child.tag <= previousTag) throw new Error('RDCleanPath: fields out of order')
    seen.add(child.tag)
    previousTag = child.tag
    switch (child.tag) {
      case TAG_CTX(0): version = derDecodeInteger(derDecodeExplicit(child, TAG_INTEGER)); break
      case TAG_CTX(2): destination = derDecodeUtf8(derDecodeExplicit(child, TAG_UTF8STRING)); break
      case TAG_CTX(3): proxyAuth = derDecodeUtf8(derDecodeExplicit(child, TAG_UTF8STRING)); break
      case TAG_CTX(5): preconnectionBlob = derDecodeUtf8(derDecodeExplicit(child, TAG_UTF8STRING)); break
      case TAG_CTX(6): x224ConnectionRequest = derDecodeExplicit(child, TAG_OCTET_STRING); break
      default: throw new Error('RDCleanPath: unexpected request field')
    }
  }
  if (version !== RDP_CLEAN_PATH_VERSION) {
    throw new Error(`RDCleanPath: unsupported version ${version} (expected ${RDP_CLEAN_PATH_VERSION})`)
  }
  if (!destination) throw new Error('RDCleanPath: missing destination')
  if (!x224ConnectionRequest) throw new Error('RDCleanPath: missing x224_connection_pdu')
  validateX224Pdu(x224ConnectionRequest, 'request')
  return { destination, proxyAuth, x224ConnectionRequest, preconnectionBlob }
}

/** 构造 RDCleanPath Response PDU（DER）：version + X.224 Confirm + 证书链 + server_addr */
export function buildRdpCleanPathResponse(serverAddr: string, x224Response: Buffer, certChain: Buffer[]): Buffer {
  validateX224Pdu(x224Response, 'confirm')
  if (!Array.isArray(certChain) || certChain.length > MAX_CERTIFICATES) throw new Error('RDCleanPath: certificate chain exceeds 64 certificates')
  let totalBytes = 0
  for (const raw of certChain) {
    if (!Buffer.isBuffer(raw) || !raw.length) throw new Error('RDCleanPath: invalid certificate')
    totalBytes += raw.length
    if (totalBytes > MAX_CERTIFICATE_BYTES) throw new Error('RDCleanPath: certificate chain exceeds 1 MiB')
  }
  const parts = [
    derWrapContext(0, derEncodeInteger(RDP_CLEAN_PATH_VERSION)),
    derWrapContext(6, derEncodeOctetString(x224Response)),
    derWrapContext(7, derWrap(TAG_SEQUENCE, Buffer.concat(certChain.map(derEncodeOctetString)))),
    derWrapContext(9, derEncodeUtf8String(serverAddr))
  ]
  return derWrap(TAG_SEQUENCE, Buffer.concat(parts))
}

/** 构造 RDCleanPath Error PDU（DER）。errorCode：1=general 2=negotiation */
export function buildRdpCleanPathError(errorCode: number, httpStatusCode?: number): Buffer {
  const errParts = [derWrapContext(0, derEncodeInteger(errorCode))]
  if (httpStatusCode != null) errParts.push(derWrapContext(1, derEncodeInteger(httpStatusCode)))
  return derWrap(TAG_SEQUENCE, Buffer.concat([
    derWrapContext(0, derEncodeInteger(RDP_CLEAN_PATH_VERSION)),
    derWrapContext(1, derWrap(TAG_SEQUENCE, Buffer.concat(errParts)))
  ]))
}

/** 从 node:tls peer certificate 提取有界 DER 证书链（自签和重复证书循环保护） */
export function extractCertChain(peerCert: tls.DetailedPeerCertificate | null): Buffer[] {
  const certs: Buffer[] = []
  if (!peerCert?.raw) return certs
  const seen = new Set<string>()
  let totalBytes = 0
  let current: tls.DetailedPeerCertificate | undefined = peerCert
  while (current?.raw) {
    if (!Buffer.isBuffer(current.raw) || !current.raw.length) throw new Error('RDCleanPath: invalid certificate')
    if (current.raw.length > MAX_CERTIFICATE_BYTES) throw new Error('RDCleanPath: certificate chain exceeds 1 MiB')
    const fingerprint = createHash('sha256').update(current.raw).digest('hex')
    if (seen.has(fingerprint)) break
    if (certs.length === MAX_CERTIFICATES) throw new Error('RDCleanPath: certificate chain exceeds 64 certificates')
    totalBytes += current.raw.length
    if (totalBytes > MAX_CERTIFICATE_BYTES) throw new Error('RDCleanPath: certificate chain exceeds 1 MiB')
    seen.add(fingerprint)
    certs.push(Buffer.from(current.raw))
    current = current.issuerCertificate && current.issuerCertificate !== current ? current.issuerCertificate : undefined
  }
  return certs
}
