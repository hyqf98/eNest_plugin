/**
 * 多线程下载引擎：单个文件的探测、分片并发、断点续传、限速与重试。
 *
 * 设计约束（都来自源项目的真实事故）：
 * - 目标文件名自始至终不变，分片直接写进最终文件，不做「先写 .part 再改名」；
 * - 每个分片请求都核对状态码与范围：服务器无视 Range 回 200 时不能把整文件当成一个分片写进去；
 * - 只有整片写完才记入进度；中途失败只丢弃本片的进度，不影响其它分片；
 * - 中止时保留目标文件与控制文件（已完成分片不丢），抛 AbortError；
 * - 403/404 等不重试（直链过期或资源失效），交给上层刷新直链。
 */

import { BackendError, type Adapter } from '../adapters/types.ts'
import { abortError, isAbortError, Semaphore, sleep } from '../util.ts'
import { LIMITS } from '../contracts.ts'
import { controlPathFor, createControlSaver, loadControl, removeControl, validateControl, type ControlFile } from './control.ts'
import { DEFAULT_CHUNK_SIZE, SegmentScheduler, planSegments, type Segment } from './segments.ts'

export interface DownloadMeta {
  /** 远端文件总大小；未知为 0 */
  size: number
  /** 服务器是否支持 Range */
  acceptRanges: boolean
  etag: string
  lastModified: string
}

export interface DownloadRequest {
  url: string
  headers?: Record<string, string>
  targetPath: string
  signal: AbortSignal
  /** 单文件并发连接数，默认 16，上限取契约的 connectionsMax */
  connections?: number
  chunkSize?: number
  /** 速率上限（字节每秒），0 表示不限速；多个连接共用 */
  speedLimit?: number
  /** 有合法控制文件时续传，默认 true */
  resume?: boolean
  onMeta?: (meta: DownloadMeta) => void
  onProgress?: (downloaded: number, total: number) => void
}

export interface DownloadResult {
  bytes: number
  meta: DownloadMeta
  /** 本次是否复用了之前已完成的分片 */
  resumed: boolean
}

const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000]
/** 引擎层的进度回调步长。任务层会按时间节流推送给页面（约每秒一次），这里只是限制回调频率，不必太粗——
 *  太粗的话慢速下载的进度条长时间不动，小于步长的文件全程显示 0% */
const PROGRESS_STEP = 64 * 1024

type ErrorKind = 'abort' | 'url-expired' | 'range' | 'disk' | 'network' | 'fatal'

/** 不重试的 HTTP 状态：直链过期、资源不存在 */
const NO_RETRY_STATUS = new Set([401, 403, 404, 410, 416])
/**
 * 值得重试的错误码（白名单）：连接被重置 / 中断、超时、卡死、连接失败、临时的 5xx。
 * 其它错误一律不重试——编程错误、请求不合法、服务器行为不符合约定，重试只会把失败推迟几十秒。
 */
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'ESTALLED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'EPROTO'])

function classifyError(error: unknown): { kind: ErrorKind; code: string; error: Error } {
  if (error instanceof RangeNotSupported) return { kind: 'range', code: 'RANGE_NOT_SUPPORTED', error }
  if (isAbortError(error)) return { kind: 'abort', code: 'ABORTED', error: error as Error }
  const err = error as { code?: unknown; status?: unknown }
  const rawCode = typeof err?.code === 'string' ? err.code : typeof err?.code === 'number' ? String(err.code) : ''
  const fromCode = rawCode.startsWith('HTTP_') ? Number(rawCode.slice(5)) : 0
  const status = (Number(err?.status) || fromCode) || 0
  if (status >= 400) {
    if (NO_RETRY_STATUS.has(status)) return { kind: 'url-expired', code: `HTTP_${status}`, error: error as Error }
    // 5xx 多为临时故障，值得重试；其余 4xx 是请求本身的问题
    return { kind: status >= 500 ? 'network' : 'fatal', code: `HTTP_${status}`, error: error as Error }
  }
  if (error instanceof BackendError) {
    if (error.code === 'URL_EXPIRED') return { kind: 'url-expired', code: 'URL_EXPIRED', error }
    if (['DISK_FULL', 'IO_ERROR'].includes(error.code)) return { kind: 'disk', code: error.code, error }
    return { kind: 'fatal', code: error.code, error }
  }
  if (['ENOSPC', 'EPERM', 'EACCES', 'EBUSY', 'EROFS'].includes(rawCode)) return { kind: 'disk', code: rawCode, error: error as Error }
  if ((error as Error)?.name === 'TimeoutError' || rawCode === 'ETIMEDOUT') return { kind: 'network', code: 'ETIMEDOUT', error: error as Error }
  if (RETRYABLE_CODES.has(rawCode)) return { kind: 'network', code: rawCode, error: error as Error }
  // 没有明确网络错误码的（TypeError 之类的编程错误、未知异常）不重试
  return { kind: 'fatal', code: rawCode || 'UNKNOWN', error: error as Error }
}

/** 服务器对分片请求无视 Range、回了整文件：重试没用，需要降级为单连接 */
export class RangeNotSupported extends BackendError {
  constructor() {
    super('RANGE_NOT_SUPPORTED', '服务器不支持分片下载')
  }
}

/** 从 content-range: bytes a-b/total 里取范围与总大小 */
export function parseContentRange(value: string | undefined): { start: number; end: number; total: number } | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(value ?? '').trim())
  if (!match) return null
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? 0 : Number(match[3]) }
}

function headerValue(headers: Record<string, string>, name: string): string {
  return String(headers[name.toLowerCase()] ?? '').trim()
}

/**
 * 探测远端文件：带 Range: bytes=0-0 打开一次。
 * 206 → 支持 Range，总大小取自 content-range；200 → 不支持，总大小取自 content-length。
 */
export async function probe(adapter: Adapter, url: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<DownloadMeta> {
  const stream = await adapter.openStream(url, { range: 'bytes=0-0', headers, signal })
  try {
    const etag = headerValue(stream.headers, 'etag')
    const lastModified = headerValue(stream.headers, 'last-modified')
    if (stream.status === 206) {
      const range = parseContentRange(headerValue(stream.headers, 'content-range'))
      const size = range?.total || Number(headerValue(stream.headers, 'content-length')) || 0
      await drainProbeBody(stream, signal)
      return { size, acceptRanges: true, etag, lastModified }
    }
    if (stream.status >= 200 && stream.status < 300) {
      const size = Number(headerValue(stream.headers, 'content-length')) || 0
      await drainProbeBody(stream, signal)
      return { size, acceptRanges: false, etag, lastModified }
    }
    throw Object.assign(new Error(`无法下载（HTTP ${stream.status}）`), { status: stream.status, code: `HTTP_${stream.status}` })
  } finally {
    stream.abort()
  }
}

/**
 * 把探测响应的那 1 个字节读完，让这条连接干净地回到连接池。
 * 探测刚结束，后面的分片请求马上就要发：在这里直接掐断连接的话，连接池可能把一条
 * 正在销毁的连接又分给下一个请求，那个请求会立刻以"连接被对端关闭"失败。
 */
async function drainProbeBody(stream: Awaited<ReturnType<Adapter['openStream']>>, signal?: AbortSignal): Promise<void> {
  for (let guard = 0; guard < 64; guard++) {
    if (signal?.aborted) throw abortError()
    const chunk = await stream.read()
    if (chunk === null) return
  }
}

/** 令牌桶：多个连接共用一个速率上限；桶容量限制为 1 秒的量，避免长时间空闲后一次性放行太多 */
class RateLimiter {
  private available = 0
  private updatedAt = Date.now()

  async take(bytes: number, limitPerSecond: number, signal: AbortSignal): Promise<void> {
    if (limitPerSecond <= 0) return
    for (;;) {
      if (signal.aborted) throw abortError()
      const now = Date.now()
      this.available = Math.min(limitPerSecond, this.available + (now - this.updatedAt) * limitPerSecond / 1000)
      this.updatedAt = now
      // 桶里的量必须够这一整块才放行；否则等到攒够为止
      if (this.available >= bytes) {
        this.available -= bytes
        return
      }
      await sleep(Math.max(5, Math.ceil(((bytes - this.available) / limitPerSecond) * 1000)), signal)
    }
  }
}

const globalRateLimiter = new RateLimiter()
/** 所有任务合计的并发连接上限，避免把带宽和连接数占满 */
const GLOBAL_CONNECTIONS = new Semaphore(LIMITS.connectionsMax * 2)

interface WorkerContext {
  url: string
  headers: Record<string, string>
  signal: AbortSignal
  speedLimit: number
  scheduler: SegmentScheduler
  writer: Awaited<ReturnType<Adapter['files']['openWriter']>>
  /** 每写入一块就调一次：标脏控制文件并上报进度 */
  onWritten: () => void
}

/**
 * 启动 count 个连接并发领取分片。首个错误出现时立刻停止领新片、中止其余连接手里的请求
 * （它们不用把各自的重试跑完），等所有连接都退出后才抛出。
 * 必须等它们退出：调用方接下来会落盘控制文件并关闭写入器，那时不能还有连接在写文件。
 */
async function runWorkers(count: number, signal: AbortSignal, work: (signal: AbortSignal) => Promise<'worked' | 'idle'>): Promise<void> {
  if (signal.aborted) throw abortError()
  // 内部信号：外部中止或任一连接出错都会触发，只作用于这批连接
  const halt = new AbortController()
  const onOuterAbort = (): void => halt.abort()
  if (signal.aborted) halt.abort()
  else signal.addEventListener('abort', onOuterAbort, { once: true })
  const outcome: { failure: unknown | undefined } = { failure: undefined }

  const worker = async (): Promise<void> => {
    while (!halt.signal.aborted) {
      try {
        if ((await work(halt.signal)) === 'idle') return
      } catch (error) {
        if (outcome.failure === undefined) {
          outcome.failure = error
          // 第一个错误：其余连接立刻收手。是外部中止时它抛出来的就是 AbortError，由调用方按中止处理
          halt.abort()
        }
        return
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: count }, worker))
  } finally {
    signal.removeEventListener('abort', onOuterAbort)
  }
  if (outcome.failure !== undefined) throw outcome.failure
  if (signal.aborted) throw abortError()
}

/** 单文件下载；任何抛错路径都会关闭写入器，中止时保留已完成的进度 */
export async function downloadFile(adapter: Adapter, request: DownloadRequest): Promise<DownloadResult> {
  try {
    return await downloadFileInner(adapter, request)
  } catch (error) {
    // 直链失效（403/404/410）在任何阶段都可能发生——包括最开始的大小探测——统一翻译成 URL_EXPIRED，
    // 交给上层刷新直链。探测在 downloadFileInner 的 try 之外，所以必须在这里兜底。
    if (error instanceof RangeNotSupported || isAbortError(error)) throw error
    if (classifyError(error).kind === 'url-expired' && !(error instanceof BackendError)) throw new BackendError('URL_EXPIRED', '下载链接已过期或资源不存在')
    throw error
  }
}

async function downloadFileInner(adapter: Adapter, request: DownloadRequest): Promise<DownloadResult> {
  const { url, targetPath, signal } = request
  const headers = { ...(request.headers ?? {}) }
  const speedLimit = request.speedLimit && request.speedLimit > 0 ? request.speedLimit : 0
  const meta = await probe(adapter, url, headers, signal)
  request.onMeta?.(meta)

  const controlPath = controlPathFor(targetPath)
  let writer: Awaited<ReturnType<Adapter['files']['openWriter']>> | null = null
  let saver: ReturnType<typeof createControlSaver> | null = null
  // 已经写到盘上的字节数（收尾时如实上报一次；平时给任务的进度回调是按步长节流的）
  let persisted = 0
  // 分片下载的调度器；走单连接路径时保持为 null（收尾时据此决定要不要报进度）
  let activeScheduler: SegmentScheduler | null = null
  try {
    writer = await adapter.files.openWriter(targetPath)
    if (!meta.acceptRanges || meta.size <= 0) {
      // 不支持 Range 或大小未知：单连接顺序写
      await downloadWhole(adapter, { url, headers, signal, speedLimit }, writer, meta, request.onProgress)
      await adapter.files.removeFile(controlPath)
      return { bytes: meta.size, meta, resumed: false }
    }

    const chunkSize = request.chunkSize && request.chunkSize > 0 ? request.chunkSize : DEFAULT_CHUNK_SIZE
    const segments = planSegments(meta.size, chunkSize)
    await writer.ensureLength(meta.size)

    // 续传：目标文件大小与远端身份都对得上才复用已下载的部分
    let resumed = false
    let doneIndexes: number[] = []
    let partial: Record<number, number> = {}
    if (request.resume !== false) {
      const control = await loadControl(adapter, targetPath)
      const actual = await adapter.files.stat(targetPath)
      if (control && actual && control.chunkSize === chunkSize && validateControl(control, actual.size, meta)) {
        doneIndexes = control.done.filter(index => index >= 0 && index < segments.length)
        partial = control.partial ?? {}
        resumed = doneIndexes.length > 0 || Object.keys(partial).length > 0
      } else {
        await adapter.files.removeFile(controlPath)
      }
    }

    const scheduler = new SegmentScheduler(segments, doneIndexes, partial)
    activeScheduler = scheduler
    const control: ControlFile = { version: 1, url, etag: meta.etag, lastModified: meta.lastModified, size: meta.size, chunkSize, done: doneIndexes }
    saver = createControlSaver(adapter, targetPath, () => ({ ...control, done: scheduler.doneIndexes(), partial: scheduler.partialMap() }))
    // 进度 = 已落盘的字节数（完成的整片 + 进行中分片里已写入的部分）。暂停、续传、进度条都用这一个口径，
    // 这样暂停时进度条不会先虚高再回落，续传时也不会重下已经写到盘上的字节。
    let lastReported = scheduler.persistedBytes()
    const onProgress = request.onProgress
    const report = (force = false): void => {
      const current = scheduler.persistedBytes()
      persisted = current
      if (force || Math.abs(current - lastReported) >= PROGRESS_STEP) {
        lastReported = current
        onProgress?.(current, meta.size)
      }
    }
    report(true)

    const releaseConnection = await GLOBAL_CONNECTIONS.acquire(signal)
    try {
      if (!scheduler.isDone()) {
        const shared: WorkerContext = {
          url, headers, signal, speedLimit, scheduler, writer,
          // 每写一块都标脏，由节流器按时落盘：暂停、断网、断电时进行中的分片也只丢最后几秒
          onWritten: () => { saver?.mark(); report() },
        }
        const remaining = segments.length - doneIndexes.length
        const connections = Math.max(1, Math.min(request.connections ?? 16, LIMITS.connectionsMax, remaining))
        await runWorkers(connections, signal, async (workerSignal) => {
          const claim = scheduler.claim()
          if (!claim) return 'idle'
          const { segment, resumeFrom } = claim
          try {
            await downloadSegmentWithRetry(adapter, { ...shared, signal: workerSignal }, segment, resumeFrom)
          } catch (error) {
            // 没下完：已写入的部分留在调度器里（下次从断点接着下），把分片放回待取
            scheduler.release(segment.index)
            throw error
          }
          scheduler.complete(segment.index)
          saver?.mark()
          report()
          return 'worked'
        })
      }
      if (!scheduler.isDone()) throw new BackendError('DOWNLOAD_INCOMPLETE', '下载未完成')
      await saver.flush()
    } finally {
      releaseConnection()
    }

    await saver.stop()
    saver = null
    await writer.close()
    writer = null
    await removeControl(adapter, targetPath)
    onProgress?.(meta.size, meta.size)
    return { bytes: meta.size, meta, resumed }
  } catch (error) {
    // 出错或中止：先把已下载的部分落盘（下次可以续传），再关闭写入器
    await saver?.flush().catch(() => undefined)
    // 收尾时把最终进度如实报一次：平时的进度回调是按步长节流的，暂停 / 失败时任务记录里的
    // 字节数会比控制文件少一些，进度条显示的就和实际能续传的对不上。
    // 只对分片下载做：单连接路径不支持续传，没有"已落盘的进度"可报。
    if (activeScheduler) request.onProgress?.(persisted, meta.size)
    await saver?.stop().catch(() => undefined)
    await writer?.close().catch(() => undefined)
    const kind = classifyError(error).kind
    if (kind === 'range') {
      // 服务器其实不支持分片：丢掉分片进度，从头用单连接重下整个文件
      await adapter.files.removeFile(controlPath).catch(() => undefined)
      const wholeMeta = { ...meta, acceptRanges: false }
      const wholeResult = await downloadWholeFile(adapter, { ...request, headers, onMeta: undefined }, wholeMeta)
      return { ...wholeResult, meta }
    }
    if (kind === 'url-expired' && !(error instanceof BackendError)) throw new BackendError('URL_EXPIRED', '下载链接已过期或资源不存在')
    throw error
  }
}

async function downloadWholeFile(adapter: Adapter, request: DownloadRequest, meta: DownloadMeta): Promise<DownloadResult> {
  const writer = await adapter.files.openWriter(request.targetPath)
  try {
    await downloadWhole(adapter, { url: request.url, headers: { ...(request.headers ?? {}) }, signal: request.signal, speedLimit: request.speedLimit ?? 0 }, writer, meta, request.onProgress)
    await adapter.files.removeFile(controlPathFor(request.targetPath))
    return { bytes: meta.size, meta, resumed: false }
  } finally {
    await writer.close().catch(() => undefined)
  }
}

/**
 * 下载一个分片，失败按指数退避重试；磁盘错误、中止、直链过期、不支持 Range 不重试。
 * resumeFrom 是分片内已连续写入的字节数，从那里接着下。
 * 重试也从"这一次已经写到的地方"接着下，而不是整段重下：写入是顺序的，调度器记的进度始终是
 * 连续的前缀，所以断到第几次都不会丢掉之前已经写到盘上的字节。
 */
async function downloadSegmentWithRetry(adapter: Adapter, context: WorkerContext, segment: Segment, resumeFrom: number): Promise<void> {
  let from = resumeFrom
  for (let attempt = 0; ; attempt++) {
    try {
      await downloadSegment(adapter, context, segment, from)
      return
    } catch (error) {
      const { kind } = classifyError(error)
      if (kind !== 'network' || attempt >= RETRY_DELAYS.length) throw error
      await sleep(RETRY_DELAYS[attempt] + Math.floor(Math.random() * 500), context.signal)
      from = context.scheduler.progressOf(segment.index)
    }
  }
}

/**
 * 下载一个分片：核对状态码与范围，整片写完才算成功。
 * 每写一块就把字节数记进调度器（它是进度的唯一来源，也决定下次续传从哪里开始）。
 */
async function downloadSegment(adapter: Adapter, context: WorkerContext, segment: Segment, resumeFrom: number): Promise<void> {
  const length = segment.end - segment.start + 1
  const from = segment.start + resumeFrom
  const stream = await adapter.openStream(context.url, { range: `bytes=${from}-${segment.end}`, headers: context.headers, signal: context.signal })
  try {
    if (stream.status !== 206) {
      if (stream.status >= 400) throw Object.assign(new Error(`下载失败（HTTP ${stream.status}）`), { status: stream.status, code: `HTTP_${stream.status}` })
      // 2xx 但不是 206：服务器无视了 Range、正在返回整文件，绝不能把它写进分片位置
      throw new RangeNotSupported()
    }
    const range = parseContentRange(headerValue(stream.headers, 'content-range'))
    if (range && (range.start !== from || range.end !== segment.end)) {
      throw new BackendError('RANGE_MISMATCH', `服务器返回的分片范围不符（收到 ${range.start}-${range.end}，期望 ${from}-${segment.end}）`)
    }
    let position = from
    let received = 0
    for (;;) {
      const chunk = await readWithStallGuard(stream, context.signal)
      if (context.signal.aborted) throw abortError()
      if (chunk === null) {
        if (received < length - resumeFrom) throw Object.assign(new Error(`连接提前结束（收到 ${received}/${length - resumeFrom} 字节）`), { code: 'ECONNRESET' })
        return
      }
      if (chunk.length === 0) continue
      await globalRateLimiter.take(chunk.length, context.speedLimit, context.signal)
      await context.writer.write(position, chunk)
      position += chunk.length
      received += chunk.length
      context.scheduler.advance(segment.index, chunk.length)
      context.onWritten()
    }
  } finally {
    stream.abort()
  }
}

/** 读一块；超过卡死阈值没有新数据就中止这次读取（交给上层重试该分片） */
async function readWithStallGuard(stream: Awaited<ReturnType<Adapter['openStream']>>, signal: AbortSignal): Promise<Uint8Array | null> {
  if (signal.aborted) throw abortError()
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('连接长时间没有数据'), { code: 'ESTALLED' })), LIMITS.stallMs)
    timer.unref?.()
    onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const chunk = await Promise.race([stream.read(), stall])
    return chunk === null ? null : chunk.bytes
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** 单连接顺序写整文件 */
async function downloadWhole(adapter: Adapter, context: { url: string; headers: Record<string, string>; signal: AbortSignal; speedLimit: number }, writer: Awaited<ReturnType<Adapter['files']['openWriter']>>, meta: DownloadMeta, onProgress?: (downloaded: number, total: number) => void): Promise<void> {
  const stream = await adapter.openStream(context.url, { headers: context.headers, signal: context.signal })
  try {
    if (stream.status < 200 || stream.status >= 300) {
      throw Object.assign(new Error(`无法下载（HTTP ${stream.status}）`), { status: stream.status, code: `HTTP_${stream.status}` })
    }
    // 走到这里说明不该有分片：若服务器其实回了 206，说明请求头里带了 Range，这里不期望
    if (meta.size > 0) await writer.ensureLength(meta.size)
    let position = 0
    let lastReported = 0
    for (;;) {
      const chunk = await readWithStallGuard(stream, context.signal)
      if (context.signal.aborted) throw abortError()
      if (chunk === null) break
      if (chunk.length === 0) continue
      await globalRateLimiter.take(chunk.length, context.speedLimit, context.signal)
      await writer.write(position, chunk)
      position += chunk.length
      if (position - lastReported >= PROGRESS_STEP) {
        lastReported = position
        onProgress?.(position, meta.size)
      }
    }
    if (meta.size > 0 && position !== meta.size) throw Object.assign(new Error(`文件不完整（收到 ${position}/${meta.size} 字节）`), { code: 'ECONNRESET' })
    onProgress?.(position, position)
  } finally {
    stream.abort()
  }
}
