/**
 * ai-canvas backend：文件保存节点的"选文件夹 → 批量写图"能力。
 *
 * 页面没有任意写盘通道（localFiles 只能读 / pickSave 单文件），目录批量写入经
 * 本后端完成：files.pick 选目录 → files.directoryTarget 解析目录内目标路径 →
 * Node fs 写文件。图片字节由页面分块 base64 传入（backend.call args 有 4 MiB 预算）。
 */
import { createWriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'

const port = process.parentPort
if (!port) throw new Error('ai-canvas backend requires an Electron utility parent')

const controls = new Map()
let sequence = 0
let closing = false
let shutdown
const writes = new Map()

function assertOpen() {
  if (closing) throw new Error('backend is closing')
}

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

function receiveHostResponse(message) {
  if (!Number.isSafeInteger(message.id) || typeof message.ok !== 'boolean') return
  const pending = controls.get(message.id)
  if (!pending) return
  controls.delete(message.id)
  clearTimeout(pending.timer)
  if (message.ok) pending.resolve(message.data)
  else pending.reject(new Error(String(message.error || 'host operation failed').slice(0, 500)))
}

function openWrite(path) {
  const stream = createWriteStream(path, { mode: 0o600 })
  const entry = { stream, path, error: null, ending: false, closed: null }
  stream.on('error', error => { entry.error ??= error })
  entry.closed = new Promise(resolve => {
    stream.once('close', () => {
      if (!stream.writableFinished) entry.error ??= new Error('文件写入未完成即关闭')
      resolve()
    })
  })
  return entry
}

function getWrite(writeId) {
  const entry = writes.get(String(writeId))
  if (!entry) throw new Error('写入会话不存在或已结束')
  if (entry.error) throw entry.error
  if (entry.ending) throw new Error('写入会话正在结束')
  return entry
}

function cancelWrite(entry, error) {
  entry.error ??= error
  entry.stream.destroy(entry.error)
}

function stop(deadlineAt) {
  if (shutdown) return shutdown
  closing = true
  const error = new Error('backend is closing')
  for (const pending of controls.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  controls.clear()
  const entries = [...writes.values()]
  for (const entry of entries) cancelWrite(entry, error)
  const budget = Number.isFinite(deadlineAt) ? Math.min(800, Math.max(0, deadlineAt - Date.now() - 50)) : 800
  shutdown = (async () => {
    let timer
    let closed = false
    try {
      closed = await Promise.race([
        Promise.all(entries.map(entry => entry.closed)).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), budget) })
      ])
      port.postMessage({ type: 'shutdown.complete', ok: closed, ...(!closed ? { error: 'file writes did not close before deadline' } : {}) })
    } catch { /* The parent channel may already be closed. */ }
    finally {
      clearTimeout(timer)
      writes.clear()
      process.exit(closed ? 0 : 1)
    }
  })()
  return shutdown
}

function reply(message) {
  if (closing) return
  try { port.postMessage(message) }
  catch { void stop() }
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
    const handles = await hostRequest('files.pick', { options: { kind: 'directory', multiple: false, access: 'write' } })
    assertOpen()
    const handle = Array.isArray(handles) ? handles[0] : null
    if (!handle?.id) return null
    return { handleId: String(handle.id), displayPath: String(handle.displayPath ?? handle.name ?? '') }
  },

  /** 打开目录内目标文件的写流（存在则覆盖） */
  async writeBegin({ handleId, name }) {
    const target = await hostRequest('files.directoryTarget', { handleId: String(handleId), name: safeName(name) })
    assertOpen()
    const path = typeof target === 'string' ? target : target?.path
    if (!path) throw new Error('目标目录授权失败')
    const writeId = randomUUID()
    const entry = openWrite(path)
    writes.set(writeId, entry)
    try {
      await once(entry.stream, 'open')
      assertOpen()
      if (entry.error) throw entry.error
      return { writeId, path }
    } catch (error) {
      cancelWrite(entry, error)
      await entry.closed
      writes.delete(writeId)
      throw entry.error
    }
  },

  /** 追加一块 base64；单块 ≤ 3 MiB 文本 */
  async writeChunk({ writeId, chunk }) {
    const entry = getWrite(writeId)
    const text = String(chunk ?? '')
    if (text.length > 4_000_000) throw new Error('分块过大')
    try {
      if (text) {
        await new Promise((resolve, reject) => {
          let settled = false
          const onClose = () => done(entry.error || new Error('文件写入已关闭'))
          const done = error => {
            if (settled) return
            settled = true
            entry.stream.off('error', done)
            entry.stream.off('close', onClose)
            if (error) reject(error)
            else resolve()
          }
          entry.stream.once('error', done)
          entry.stream.once('close', onClose)
          try { entry.stream.write(Buffer.from(text, 'base64'), done) }
          catch (error) { done(error) }
        })
      }
      assertOpen()
      if (entry.error) throw entry.error
      return true
    } catch (error) {
      cancelWrite(entry, error)
      await entry.closed
      writes.delete(String(writeId))
      throw entry.error
    }
  },

  /** 收尾并返回落盘路径 */
  async writeEnd({ writeId }) {
    const entry = getWrite(writeId)
    entry.ending = true
    try {
      try { entry.stream.end(error => { if (error) cancelWrite(entry, error) }) }
      catch (error) { cancelWrite(entry, error) }
      // Keep ending streams reachable by abort/shutdown until the file descriptor closes.
      await entry.closed
      assertOpen()
      if (entry.error) throw entry.error
      return { path: entry.path }
    } finally { writes.delete(String(writeId)) }
  },

  /** 放弃写入（页面报错时清理句柄，不删已落部分） */
  async writeAbort({ writeId }) {
    const entry = writes.get(String(writeId))
    if (!entry) return true
    cancelWrite(entry, new Error('文件写入已取消'))
    await entry.closed
    writes.delete(String(writeId))
    return true
  }
}

process.once('SIGTERM', () => { void stop() })
process.once('SIGINT', () => { void stop() })
port.on('close', () => { void stop() })

port.on('message', async ({ data }) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  if (data.type === 'host.response') { receiveHostResponse(data); return }
  if (data.type === 'shutdown') { void stop(data.deadlineAt); return }
  if (closing || data.type) return
  const { id, method, args = [] } = data
  if (!Number.isSafeInteger(id) || typeof method !== 'string' || !Object.hasOwn(methods, method) || !Array.isArray(args)) return
  try {
    const result = await methods[method](...args)
    reply({ id, ok: true, data: result })
  } catch (error) {
    reply({ id, ok: false, error: String(error?.message ?? error).slice(0, 500) })
  }
})
