/**
 * 断点续传的控制文件：记录目标文件的远端身份与已完成的分片。
 * 文件名固定为「目标文件路径 + .ghctl」，先写临时文件再原子替换。
 */

import type { Adapter } from '../adapters/types.ts'
import { BackendError } from '../adapters/types.ts'

export interface ControlFile {
  version: 1
  url: string
  etag: string
  lastModified: string
  /** 目标文件总大小 */
  size: number
  chunkSize: number
  /** 已完成的分片序号（升序） */
  done: number[]
  /**
   * 没下完的分片里已连续写入的字节数（分片序号 → 字节数，从分片开头起）。
   * 旧版本的控制文件没有这个字段，按空处理（进行中的分片整片重下）。
   */
  partial?: Record<number, number>
}

export interface RemoteMeta {
  size: number
  etag: string
  lastModified: string
}

export function controlPathFor(targetPath: string): string {
  return `${targetPath}.ghctl`
}

function tempPathFor(targetPath: string): string {
  return `${targetPath}.ghctl.tmp`
}

export async function loadControl(adapter: Adapter, targetPath: string): Promise<ControlFile | null> {
  let raw: Uint8Array
  try {
    raw = await adapter.files.readFile(controlPathFor(targetPath), 4 * 1024 * 1024)
  } catch {
    return null
  }
  if (!raw || raw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const value = parsed as Partial<ControlFile>
  const size = value.size
  const chunkSize = value.chunkSize
  if (value.version !== 1 || typeof value.url !== 'string' || typeof value.etag !== 'string' || typeof value.lastModified !== 'string') return null
  if (!Number.isSafeInteger(size) || (size as number) < 0 || !Number.isSafeInteger(chunkSize) || (chunkSize as number) <= 0) return null
  if (!Array.isArray(value.done) || !value.done.every(index => Number.isSafeInteger(index) && index >= 0)) return null
  // partial 可选；形状不对就当没有（只影响断点精度，不影响正确性：调度器还会再筛一遍）
  const partial: Record<number, number> = {}
  if (value.partial && typeof value.partial === 'object' && !Array.isArray(value.partial)) {
    for (const [index, bytes] of Object.entries(value.partial)) {
      if (Number.isSafeInteger(Number(index)) && Number.isSafeInteger(Number(bytes)) && Number(bytes) > 0) partial[Number(index)] = Number(bytes)
    }
  }
  return {
    version: 1,
    url: value.url,
    etag: value.etag,
    lastModified: value.lastModified,
    size: size as number,
    chunkSize: chunkSize as number,
    done: [...new Set(value.done as number[])].sort((a, b) => a - b),
    ...(Object.keys(partial).length ? { partial } : {}),
  }
}

export async function saveControl(adapter: Adapter, targetPath: string, control: ControlFile): Promise<void> {
  const temp = tempPathFor(targetPath)
  // 没有片内进度时不写 partial 字段（空的 {} 也不写）
  const partial = control.partial && Object.keys(control.partial).length > 0 ? control.partial : undefined
  const payload = new TextEncoder().encode(JSON.stringify({ ...control, done: [...control.done].sort((a, b) => a - b), partial }))
  await adapter.files.writeFile(temp, payload)
  await adapter.files.rename(temp, controlPathFor(targetPath))
}

export async function removeControl(adapter: Adapter, targetPath: string): Promise<void> {
  await adapter.files.removeFile(tempPathFor(targetPath))
  await adapter.files.removeFile(controlPathFor(targetPath))
}

/**
 * 续传校验：目标文件的实际大小必须等于记录的大小；远端身份（ETag 或 Last-Modified）必须没变。
 * 新旧元数据里 ETag 与 Last-Modified 都为空时视为一致（服务器不提供身份，只能选择信任）。
 * 只有一方提供了身份而对不上，视为远端已变，必须从头下载。
 */
export function validateControl(control: ControlFile, actualSize: number, meta: RemoteMeta): boolean {
  if (actualSize !== control.size) return false
  if (meta.size > 0 && meta.size !== control.size) return false
  if (control.etag && meta.etag) return control.etag === meta.etag
  if (control.lastModified && meta.lastModified) return control.lastModified === meta.lastModified
  // 记录里有身份但新探测没拿到（或反过来）：无法确认是同一文件，保守起见不续传
  if (control.etag && !meta.etag) return false
  if (control.lastModified && !meta.lastModified) return false
  return true
}

/**
 * 节流落盘：mark() 之后最多每 intervalMs 写一次盘，flush() 立即写。
 * 保存期间的新标记不会丢：每次保存都取调用方给出的最新内容。
 */
export function createControlSaver(adapter: Adapter, targetPath: string, getControl: () => ControlFile, intervalMs = 10_000): { mark(): void; flush(): Promise<void>; stop(): Promise<void> } {
  let timer: NodeJS.Timeout | undefined
  let dirty = false
  let inFlight: Promise<void> | null = null
  let pendingAgain = false

  const write = (): Promise<void> => {
    if (inFlight) {
      pendingAgain = true
      return inFlight
    }
    inFlight = (async () => {
      do {
        pendingAgain = false
        dirty = false
        await saveControl(adapter, targetPath, getControl())
      } while (pendingAgain)
    })().finally(() => {
      inFlight = null
      if (pendingAgain) void write()
    })
    return inFlight
  }

  return {
    mark(): void {
      dirty = true
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        if (dirty) void write().catch(error => { throw mapIoError(error, targetPath) })
      }, intervalMs)
      timer.unref?.()
    },
    async flush(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = undefined }
      if (inFlight) { pendingAgain = true; await inFlight; if (pendingAgain) await write(); return }
      if (dirty) await write()
    },
    async stop(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = undefined }
      dirty = false
      if (inFlight) await inFlight.catch(() => undefined)
    },
  }
}

function mapIoError(error: unknown, targetPath: string): unknown {
  if (error instanceof BackendError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new BackendError('IO_ERROR', `保存下载进度失败：${message}（${targetPath}）`)
}
