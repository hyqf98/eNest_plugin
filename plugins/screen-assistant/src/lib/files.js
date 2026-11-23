/** 私有文件：files.stream 写入 / storage.files 分片读取。 */
import { host } from './env.js'

export const CHUNK = 512 * 1024

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  webm: 'video/webm'
}

export function mimeForExtension(extension) {
  return MIME_BY_EXT[String(extension || '').toLowerCase().replace(/^\./, '')] || 'application/octet-stream'
}

export function extensionForMime(mime) {
  const value = String(mime || '')
  if (value === 'image/jpeg') return 'jpg'
  if (value === 'image/webp') return 'webp'
  if (value === 'image/gif') return 'gif'
  if (value === 'video/webm') return 'webm'
  return 'png'
}

export function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes
  if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  throw new Error('文件分片格式无效')
}

/** 串行写入一个私有输出；首次 write 时打开流。 */
export class StreamSink {
  constructor(extension) {
    this.extension = extension
    this.streamId = ''
    this.sequence = 0
    this.bytes = 0
    this.chain = Promise.resolve()
    this.opening = null
    this.aborted = false
    this.finished = null
  }

  async open() {
    if (this.streamId) return this.streamId
    if (!this.opening) {
      this.opening = host.files.stream.open({ extension: this.extension }).then(result => {
        this.streamId = result.streamId
        return result.streamId
      })
    }
    return this.opening
  }

  write(bytes) {
    const buffer = toArrayBuffer(bytes)
    this.chain = this.chain.then(async () => {
      if (this.aborted) throw new Error('写入已取消')
      const streamId = await this.open()
      // The host accepts at most 512 KiB per write; split larger buffers so
      // fullscreen PNGs, extracted frames and GIF outputs all go through one path.
      for (let offset = 0; offset < buffer.byteLength; offset += CHUNK) {
        const slice = buffer.slice(offset, Math.min(buffer.byteLength, offset + CHUNK))
        await host.files.stream.write(streamId, this.sequence++, slice)
        this.bytes += slice.byteLength
      }
    })
    return this.chain
  }

  finish() {
    if (this.finished) return this.finished
    this.finished = this.chain.then(async () => {
      if (this.aborted) throw new Error('写入已取消')
      const streamId = await this.open()
      const result = await host.files.stream.finish(streamId)
      this.streamId = ''
      return { ...result, bytes: result.size ?? this.bytes }
    })
    return this.finished
  }

  async abort() {
    if (this.aborted) return
    this.aborted = true
    this.chain = this.chain.catch(() => {})
    await this.chain
    if (this.streamId) {
      const id = this.streamId
      this.streamId = ''
      await host.files.stream.abort(id).catch(() => {})
    }
  }
}

/** 读取一个私有文件的全部字节（分片循环）。 */
export async function readFileBytes(fileId, { maxBytes = 256 * 1024 * 1024, onProgress } = {}) {
  const chunks = []
  let offset = 0
  let total = 0
  for (;;) {
    const chunk = await host.storage.files.get(fileId, { offset, length: CHUNK })
    if (!chunk) break
    const bytes = new Uint8Array(toArrayBuffer(chunk.bytes))
    if (bytes.byteLength) {
      total += bytes.byteLength
      if (total > maxBytes) throw new Error('文件超过插件内处理上限，请先导出')
      chunks.push(bytes)
      onProgress?.(total)
    }
    if (chunk.nextOffset == null || chunk.nextOffset <= offset) break
    offset = chunk.nextOffset
  }
  if (!chunks.length) throw new Error('文件内容为空或已不存在')
  const merged = new Uint8Array(total)
  let cursor = 0
  for (const chunk of chunks) { merged.set(chunk, cursor); cursor += chunk.byteLength }
  return merged
}

export async function readFileBlob(file, { maxBytes } = {}) {
  const bytes = await readFileBytes(file.fileId || file.id, { maxBytes })
  const extension = file.extension || (file.kind === 'video' ? 'webm' : file.kind === 'gif' ? 'gif' : 'png')
  return new Blob([bytes], { type: mimeForExtension(extension) })
}

export function base64ToBytes(dataUrl) {
  const value = String(dataUrl || '')
  const comma = value.indexOf(',')
  if (comma < 0) throw new Error('图片数据无效')
  const binary = atob(value.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function dataUrlToBlob(dataUrl) {
  const value = String(dataUrl || '')
  const mime = /^data:([^;,]+)/.exec(value)?.[1] || 'application/octet-stream'
  return new Blob([base64ToBytes(value)], { type: mime })
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('结果读取失败'))
    reader.readAsDataURL(blob)
  })
}

export function bytesToDataUrl(bytes, mime = 'image/png') {
  let binary = ''
  const view = new Uint8Array(bytes)
  const step = 0x8000
  for (let i = 0; i < view.length; i += step) binary += String.fromCharCode(...view.subarray(i, i + step))
  return `data:${mime};base64,${btoa(binary)}`
}

export async function fileToDataUrl(fileId, mime, options) {
  return bytesToDataUrl(await readFileBytes(fileId, options), mime)
}

export async function writeBlob(blob, extension) {
  const sink = new StreamSink(extension)
  try {
    await sink.write(await blob.arrayBuffer())
    return await sink.finish()
  } catch (error) {
    await sink.abort()
    throw error
  }
}

export function canvasToBlob(canvas, mime = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('图片编码失败'))), mime, quality)
  })
}

export async function exportFile(fileId, defaultName) {
  return host.storage.files.export(fileId, { defaultName })
}

export async function removeFile(fileId) {
  if (!fileId) return false
  return host.storage.files.remove(fileId).catch(() => false)
}

/** 遍历本插件全部私有输出。 */
export async function listFiles() {
  const items = []
  const cursors = new Set()
  let cursor
  do {
    const page = await host.storage.files.list({ cursor, limit: 200 })
    items.push(...page.items)
    cursor = page.nextCursor
    if (cursor && (cursors.has(cursor) || cursors.size >= 41)) throw new Error('私有文件列表异常')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return items
}
