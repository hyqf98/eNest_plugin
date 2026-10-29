/**
 * ai-canvas backend：文件保存节点的"选文件夹 → 批量写图"能力。
 *
 * 页面没有任意写盘通道（localFiles 只能读 / pickSave 单文件），目录批量写入经
 * 本后端完成：files.pick 选目录 → files.directoryTarget 解析目录内目标路径 →
 * Node fs 写文件。图片字节由页面分块 base64 传入（backend.call args 有 4 MiB 预算）。
 */
import { createWriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'

const port = process.parentPort
if (!port) throw new Error('ai-canvas backend requires an Electron utility parent')

const controls = new Map()
let sequence = 0
let closing = false
const writes = new Map()

function hostRequest(method, params) {
  if (closing) return Promise.reject(new Error('backend is closing'))
  if (controls.size >= 64) return Promise.reject(new Error('too many pending host operations'))
  const id = ++sequence
  return new Promise((resolve, reject) => {
    // 原生目录选择器由用户操作，节奏不可控
    const timeout = method === 'files.pick' ? 86_400_000 : 30_000
    const timer = setTimeout(() => { controls.delete(id); reject(new Error(`host operation timed out: ${method}`)) }, timeout)
    timer.unref()
    controls.set(id, { resolve, reject, timer })
    try { port.postMessage({ type: 'host.request', id, method, params }) }
    catch (error) { controls.delete(id); clearTimeout(timer); reject(error) }
  })
}

/** 纯文件名：拒绝路径分隔符 / 点段，目录内命名由 directoryTarget 兜底约束 */
function safeName(raw) {
  const name = String(raw ?? '').trim()
  if (!name || name.length > 200 || /[\0/\\]|\.{2}/.test(name)) throw new Error(`非法文件名：${name.slice(0, 40) || '(空)'}`)
  return name
}

const methods = {
  /** 打开原生目录选择器；返回 { handleId, displayPath } 或 null（取消） */
  async pickDirectory() {
    const handles = await hostRequest('files.pick', { options: { kind: 'directory', multiple: false } })
    const handle = Array.isArray(handles) ? handles[0] : null
    if (!handle?.id) return null
    return { handleId: String(handle.id), displayPath: String(handle.displayPath ?? handle.name ?? '') }
  },

  /** 打开目录内目标文件的写流（存在则覆盖） */
  async writeBegin({ handleId, name }) {
    const target = await hostRequest('files.directoryTarget', { handleId: String(handleId), name: safeName(name) })
    const path = typeof target === 'string' ? target : target?.path
    if (!path) throw new Error('目标目录授权失败')
    const writeId = randomUUID()
    writes.set(writeId, { stream: createWriteStream(path, { mode: 0o600 }), path })
    return { writeId, path }
  },

  /** 追加一块 base64；单块 ≤ 3 MiB 文本 */
  writeChunk({ writeId, chunk }) {
    const entry = writes.get(String(writeId))
    if (!entry) throw new Error('写入会话不存在或已结束')
    const text = String(chunk ?? '')
    if (text.length > 4_000_000) throw new Error('分块过大')
    if (text) entry.stream.write(Buffer.from(text, 'base64'))
    return true
  },

  /** 收尾并返回落盘路径 */
  writeEnd({ writeId }) {
    const entry = writes.get(String(writeId))
    if (!entry) throw new Error('写入会话不存在或已结束')
    writes.delete(String(writeId))
    return new Promise((resolve, reject) => {
      entry.stream.on('error', reject)
      entry.stream.end(() => resolve({ path: entry.path }))
    })
  },

  /** 放弃写入（页面报错时清理句柄，不删已落部分） */
  writeAbort({ writeId }) {
    const entry = writes.get(String(writeId))
    writes.delete(String(writeId))
    entry?.stream?.destroy()
    return true
  }
}

port.on('message', async ({ data: raw }) => {
  const data = raw
  const { id, method, args = [] } = data ?? {}
  if (!Number.isInteger(id) || typeof method !== 'string' || !Object.hasOwn(methods, method) || !Array.isArray(args)) return
  try {
    const result = await methods[method](...args)
    port.postMessage({ id, ok: true, data: result })
  } catch (error) {
    port.postMessage({ id, ok: false, error: String(error?.message ?? error).slice(0, 500) })
  }
})
