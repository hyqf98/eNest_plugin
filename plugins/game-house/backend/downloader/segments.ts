/**
 * 分片划分与调度（纯逻辑，不依赖适配层）。
 */

export interface Segment {
  /** 分片序号，从 0 开始 */
  index: number
  /** 起始字节偏移（含） */
  start: number
  /** 结束字节偏移（含） */
  end: number
}

export const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024

/** 把 [0, total) 划成每片不超过 chunkSize 的连续区间；total 非正数时返回空数组 */
export function planSegments(total: number, chunkSize: number = DEFAULT_CHUNK_SIZE): Segment[] {
  if (!Number.isSafeInteger(total) || total <= 0) return []
  const size = Number.isSafeInteger(chunkSize) && chunkSize > 0 ? chunkSize : DEFAULT_CHUNK_SIZE
  const segments: Segment[] = []
  for (let start = 0, index = 0; start < total; start += size, index++) {
    segments.push({ index, start, end: Math.min(start + size, total) - 1 })
  }
  return segments
}

/** 领到的活：整片重下时 resumeFrom 为 0；续传时为分片内已连续写入的字节数 */
export interface Claim {
  segment: Segment
  resumeFrom: number
}

/**
 * 分片调度：多个连接并发领取未分配的分片，整片写完才算完成，中途失败放回。
 * 同一时刻一个分片只会被一个连接持有。
 *
 * 断点的粒度是"分片内已连续写入的前缀"：暂停 / 断网 / 关闭时，进行中的分片记下已经写到哪，
 * 下次从那里接着下。只按整片记的话，一个 10 MiB 的分片下到 9.9 MiB 时暂停也会全部丢掉，
 * 16 个连接同时在进行时一次暂停最多白下 160 MiB。
 */
export class SegmentScheduler {
  private readonly segments: Segment[]
  private readonly sizes: number[]
  private readonly state: Uint8Array // 0 待取 1 进行中 2 完成
  /** 进行中的分片：已连续写入的字节数（从分片开头起） */
  private readonly progress: Map<number, number> = new Map()
  private readonly total: number
  private doneBytes = 0
  private doneCount = 0

  constructor(segments: Segment[], doneIndexes: Iterable<number> = [], partial: Record<number, number> = {}) {
    this.segments = segments
    this.sizes = segments.map(segment => segment.end - segment.start + 1)
    this.total = this.sizes.reduce((sum, size) => sum + size, 0)
    this.state = new Uint8Array(segments.length)
    for (const index of doneIndexes) this.markDone(index)
    // 上次没收尾的分片：记下续传起点。已经写满的当作完成，越界或非法的忽略
    for (const [rawIndex, rawBytes] of Object.entries(partial)) {
      const index = Number(rawIndex)
      const bytes = Number(rawBytes)
      if (!Number.isSafeInteger(index) || index < 0 || index >= this.state.length || this.state[index] !== 0) continue
      if (!Number.isSafeInteger(bytes) || bytes <= 0) continue
      if (bytes >= this.sizes[index]) { this.markDone(index); continue }
      this.progress.set(index, bytes)
    }
  }

  private markDone(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.state.length || this.state[index] === 2) return
    this.state[index] = 2
    this.progress.delete(index)
    this.doneBytes += this.sizes[index]
    this.doneCount++
  }

  /** 分片长度 */
  sizeOf(index: number): number { return this.sizes[index] ?? 0 }

  totalBytes(): number { return this.total }
  completedBytes(): number { return this.doneBytes }
  completedCount(): number { return this.doneCount }
  segmentCount(): number { return this.segments.length }
  isDone(): boolean { return this.doneCount === this.segments.length }
  isCompleted(index: number): boolean { return this.state[index] === 2 }

  /** 已落盘的字节数：完成的整片 + 进行中分片里已连续写入的部分。暂停 / 续传时的进度以它为准 */
  persistedBytes(): number {
    let sum = this.doneBytes
    for (const bytes of this.progress.values()) sum += bytes
    return sum
  }

  /** 取下一个待取的分片（优先接着上次没下完的）；全部完成或全在进行中时返回 null */
  claim(): Claim | null {
    // 上一轮没收尾的分片先续：它们的字节已经在盘上，先补完才能尽早让进度"落袋"
    for (const index of this.progress.keys()) {
      if (this.state[index] === 0) {
        this.state[index] = 1
        return { segment: this.segments[index], resumeFrom: this.progress.get(index) ?? 0 }
      }
    }
    for (let index = 0; index < this.state.length; index++) {
      if (this.state[index] === 0) {
        this.state[index] = 1
        return { segment: this.segments[index], resumeFrom: 0 }
      }
    }
    return null
  }

  /** 进行中的分片又写入了一些字节 */
  advance(index: number, bytes: number): void {
    if (this.state[index] !== 1) return
    this.progress.set(index, Math.min(this.sizes[index], (this.progress.get(index) ?? 0) + bytes))
  }

  /** 进行中的分片已连续写入的字节数（没写过是 0）。分片重试时从这里接着下 */
  progressOf(index: number): number {
    if (this.state[index] === 2) return this.sizes[index]
    return this.progress.get(index) ?? 0
  }

  /** 整片写完 */
  complete(index: number): void {
    if (this.state[index] === 2) return
    this.markDone(index)
  }

  /** 中途失败：放回待取队列。已写入的部分保留，下次从断点接着下 */
  release(index: number): void {
    if (this.state[index] === 1) this.state[index] = 0
  }

  doneIndexes(): number[] {
    const result: number[] = []
    for (let index = 0; index < this.state.length; index++) if (this.state[index] === 2) result.push(index)
    return result
  }

  /** 进行中 / 中断的分片里已连续写入的字节数（序号 → 字节数），写进控制文件供下次续传 */
  partialMap(): Record<number, number> {
    const result: Record<number, number> = {}
    for (const [index, bytes] of this.progress) {
      if (this.state[index] !== 2 && bytes > 0) result[index] = bytes
    }
    return result
  }
}
