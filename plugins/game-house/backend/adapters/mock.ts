/**
 * 模拟适配层：单测用。不联网、不启动子进程。
 * - 网络：内存里的假响应；流式下载按内容长度吐出确定性的假字节，可配置速度、断流、直链过期；
 * - 文件：临时目录里的真实读写（分片写入、控制文件、续传都用真文件验证）；
 * - 解压：在输出目录里按"归档清单"造出假文件；
 * - 进程：内存里的假进程表。
 */

import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { BackendError, type Adapter, type ArchiveOps, type ByteStream, type ExtractOptions, type ExtractResult, type FileOps, type HttpRequest, type LaunchedProcess, type PathOps, type ProcessOps, type ProgressWriter, type RawResponse } from './types.ts'

export interface MockFileSpec {
  name: string
  size: number
}

export interface MockArchiveSpec {
  /** 解压后会在输出目录造出的文件 */
  outputs: MockFileSpec[]
  /** 模拟退出码；默认 0 */
  exitCode?: number
  /** 解压"耗时"（毫秒），用于测试安装中的状态 */
  durationMs?: number
}

export interface MockOptions {
  /** 假网络的总速率（字节每秒）；0 表示不限速 */
  bytesPerSecond?: number
  /** 流式下载时每吐多少字节检查一次限速 */
  chunkSize?: number
}

/** 登记假响应时可以省略的字段（status 默认 200，其余默认空） */
export type MockResponse = Partial<RawResponse> & { body?: Uint8Array | string }

export class MockNetwork {
  /** 函数式响应能拿到的请求信息：按查询参数路由的接口（分页、文件 id）需要它 */
  readonly responses = new Map<string, RawResponse | ((request: { url: string; method: string; headers: Record<string, string> }) => RawResponse | Promise<RawResponse>)>()
  /** 已登记的流式资源：url → 资源 */
  readonly streams = new Map<string, MockStreamResource>()
  /** 请求记录，供测试断言 */
  readonly log: Array<{ url: string; method: string; headers: Record<string, string>; range?: string }> = []
  bytesPerSecond = 0
  chunkSize = 256 * 1024
  /** 当前挂起的流；abortAll() 用 */
  readonly live = new Set<MockByteStream>()

  /**
   * 登记一个假响应。查表规则：先按完整 URL 精确匹配；匹配不到再按「去掉查询串后的地址」匹配。
   * 这样带时间戳这类变化查询参数的接口（如天翼云的 noCache=…）只需登记不含查询串的地址。
   * 响应是函数时会收到实际请求（url / method / headers），可以按查询参数给出不同响应。
   */
  respond(url: string, response: MockResponse | ((request: { url: string; method: string; headers: Record<string, string> }) => MockResponse | Promise<MockResponse>)): void {
    const normalize = (value: MockResponse): RawResponse => ({
      status: value.status ?? 200,
      headers: { ...(value.headers ?? {}) },
      setCookies: [...(value.setCookies ?? [])],
      location: value.location ?? '',
      body: typeof value.body === 'string' ? new TextEncoder().encode(value.body) : (value.body ?? new Uint8Array()),
    })
    this.responses.set(url, typeof response === 'function' ? async request => normalize(await response(request)) : normalize(response))
  }

  /** 按与 request() 相同的规则查找已登记的响应 */
  lookup(url: string): (RawResponse | ((request: { url: string; method: string; headers: Record<string, string> }) => RawResponse | Promise<RawResponse>)) | undefined {
    const exact = this.responses.get(url)
    if (exact) return exact
    const stripped = url.split('?')[0]
    if (stripped === url) return undefined
    return this.responses.get(stripped)
  }

  stream(url: string, resource: MockStreamResource): void {
    this.streams.set(url, resource)
  }

  abortAll(): void {
    for (const stream of this.live) stream.abort()
  }
}

export interface MockStreamResource {
  size: number
  /** 是否支持 Range */
  acceptRanges?: boolean
  etag?: string
  lastModified?: string
  /** 第 n 次打开该资源时直接失败（模拟直链过期 / 网络抖动） */
  failAttempts?: number
  /** 每吐出这么多个块后故意断开一次（模拟断流），-1 表示不断 */
  breakAfterChunks?: number
  headers?: Record<string, string>
}

class MockByteStream implements ByteStream {
  readonly status: number
  readonly headers: Record<string, string>
  readonly setCookies: string[] = []
  private offset: number
  private readonly end: number
  private closed = false
  private chunksServed = 0
  private readonly aborted = false
  private readonly network: MockNetwork
  private readonly resource: MockStreamResource
  private readonly signal: AbortSignal | undefined

  constructor(network: MockNetwork, resource: MockStreamResource, range: { start: number; end: number } | null, headers: Record<string, string>, signal?: AbortSignal) {
    this.network = network
    this.resource = resource
    this.signal = signal
    this.headers = { ...resource.headers, ...headers }
    if (range) {
      this.status = 206
      this.offset = range.start
      this.end = range.end
      this.headers['content-range'] = `bytes ${range.start}-${range.end}/${resource.size}`
      this.headers['content-length'] = String(range.end - range.start + 1)
    } else {
      this.status = 200
      this.offset = 0
      this.end = resource.size - 1
      this.headers['content-length'] = String(resource.size)
    }
    this.headers.etag = resource.etag ?? ''
    this.headers['last-modified'] = resource.lastModified ?? ''
    network.live.add(this)
  }

  async read(): Promise<{ bytes: Uint8Array; at: number } | null> {
    if (this.closed || this.aborted) return null
    if (this.signal?.aborted) { this.close(); return null }
    if (this.offset > this.end) { this.close(); return null }
    const remaining = this.end - this.offset + 1
    const length = Math.min(this.network.chunkSize, remaining)
    if (this.network.bytesPerSecond > 0) {
      await new Promise(resolve => setTimeout(resolve, (length / this.network.bytesPerSecond) * 1000))
    }
    if (this.signal?.aborted || this.aborted) { this.close(); return null }
    const bytes = new Uint8Array(length)
    // 确定性内容：按偏移填充，测试可用 contentAt 校验写入是否错位。
    fillDeterministic(bytes, this.offset)
    this.offset += length
    this.chunksServed++
    if (this.resource.breakAfterChunks !== undefined && this.resource.breakAfterChunks >= 0 && this.chunksServed >= this.resource.breakAfterChunks && this.offset <= this.end) {
      this.close()
      throw Object.assign(new Error('模拟断流：连接被重置'), { code: 'ECONNRESET' })
    }
    if (this.offset > this.end) this.close()
    return { bytes, at: Date.now() }
  }

  abort(): void {
    this.close()
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    this.network.live.delete(this)
  }
}

/** 确定性假字节：位置 → 内容，便于校验分片有没有写错位置 */
export function fillDeterministic(target: Uint8Array, offset: number): void {
  for (let i = 0; i < target.length; i++) target[i] = (offset + i) % 251
}

export function contentAt(position: number, length: number): Uint8Array {
  const out = new Uint8Array(length)
  fillDeterministic(out, position)
  return out
}

export async function createMockAdapter(options: MockOptions = {}): Promise<{ adapter: Adapter; network: MockNetwork; archives: MockArchiveRegistry; processes: MockProcessTable; root: string; cleanup(): Promise<void> }> {
  const network = new MockNetwork()
  network.bytesPerSecond = options.bytesPerSecond ?? 0
  network.chunkSize = options.chunkSize ?? 256 * 1024
  const archives = new MockArchiveRegistry()
  const processes = new MockProcessTable()
  const root = await fs.mkdtemp(nodePath.join(process.env.TEMP ?? tmpdir(), 'game-house-mock-'))

  const pathOps: PathOps = {
    join: (...parts) => nodePath.join(...parts),
    resolve: value => nodePath.resolve(value),
    dirname: value => nodePath.dirname(value),
    basename: value => nodePath.basename(value),
    extname: value => nodePath.extname(value),
    isAbsolute: value => nodePath.isAbsolute(value),
  }

  const files: FileOps = {
    async ensureDir(path) { await fs.mkdir(path, { recursive: true }) },
    async isDirectory(path) { try { return (await fs.stat(path)).isDirectory() } catch { return false } },
    async stat(path) { try { const s = await fs.stat(path); return { size: s.size, isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs } } catch { return null } },
    async remove(path) { await fs.rm(path, { force: true, recursive: true }) },
    async removeFile(path) { await fs.rm(path, { force: true }) },
    async removeDir(path) { await fs.rm(path, { force: true, recursive: true }) },
    async rename(from, to) { await fs.rename(from, to) },
    async readFile(path, maxBytes) { const data = await fs.readFile(path); return maxBytes && data.length > maxBytes ? new Uint8Array(data.subarray(0, maxBytes)) : new Uint8Array(data) },
    async writeFile(path, bytes) { await fs.mkdir(nodePath.dirname(path), { recursive: true }); await fs.writeFile(path, bytes) },
    async listDir(path) {
      const entries = await fs.readdir(path, { withFileTypes: true })
      const out: Array<{ name: string; isDirectory: boolean; size: number }> = []
      for (const entry of entries) {
        const stat = await fs.stat(nodePath.join(path, entry.name))
        out.push({ name: entry.name, isDirectory: entry.isDirectory(), size: stat.size })
      }
      return out
    },
    async freeSpace() { return 1024 * 1024 * 1024 * 1024 },
    async openWriter(path) { return new MockWriter(path) },
    // 模拟环境里也做真实的流式拼接：分卷回退的测试需要验证拼接结果确实可解压
    async concatFiles(sources, target, signal, onProgress) {
      await fs.mkdir(nodePath.dirname(target), { recursive: true })
      const sizes = await Promise.all(sources.map(async source => (await fs.stat(source)).size))
      const total = sizes.reduce((sum, size) => sum + size, 0)
      const CHUNK = 1024 * 1024
      const output = await fs.open(target, 'w')
      let copied = 0
      try {
        const buffer = Buffer.alloc(CHUNK)
        for (const source of sources) {
          if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
          const input = await fs.open(source, 'r')
          try {
            for (;;) {
              const { bytesRead } = await input.read(buffer, 0, CHUNK, null)
              if (bytesRead === 0) break
              await output.write(buffer, 0, bytesRead)
              copied += bytesRead
              onProgress?.(copied, total)
            }
          } finally {
            await input.close()
          }
        }
      } finally {
        await output.close()
      }
    },
    async reveal() { /* 模拟环境没有文件管理器 */ },
  }

  const archive: ArchiveOps = {
    async available() { return true },
    async extract(options: ExtractOptions): Promise<ExtractResult> {
      const spec = archives.lookup(options.archive)
      if (!spec) return { exitCode: 2, tail: `Cannot open as archive: ${nodePath.basename(options.archive)}` }
      const step = Math.max(1, Math.min(50, spec.durationMs ?? 40))
      for (let waited = 0; waited < (spec.durationMs ?? 40); waited += step) {
        if (options.signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
        await new Promise(resolve => setTimeout(resolve, step))
        options.onProgress?.()
      }
      if (options.signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
      for (const output of spec.outputs) {
        const target = nodePath.join(options.outputDir, output.name)
        await fs.mkdir(nodePath.dirname(target), { recursive: true })
        await fs.writeFile(target, Buffer.alloc(output.size))
      }
      archives.extractions.push({ archive: options.archive, outputDir: options.outputDir })
      return { exitCode: spec.exitCode ?? 0, tail: spec.exitCode ? 'Warning: some files could not be extracted' : '' }
    },
  }

  const adapter: Adapter = {
    async request(options: HttpRequest): Promise<RawResponse> {
      network.log.push({ url: options.url, method: options.method ?? 'GET', headers: { ...(options.headers ?? {}) }, range: options.headers?.range ?? options.headers?.Range })
      const entry = network.lookup(options.url)
      if (!entry) throw new BackendError('NETWORK', `模拟网络没有登记该地址：${options.url.split('?')[0].slice(0, 120)}`)
      const response = typeof entry === 'function' ? await entry({ url: options.url, method: options.method ?? 'GET', headers: { ...(options.headers ?? {}) } }) : entry
      return response
    },
    async openStream(url, openOptions = {}) {
      const resource = network.streams.get(url)
      if (!resource) throw new BackendError('NETWORK', `模拟网络没有登记该资源：${url.slice(0, 120)}`)
      if (resource.failAttempts && resource.failAttempts > 0) {
        resource.failAttempts--
        throw Object.assign(new Error('模拟请求失败'), { code: 'ECONNRESET' })
      }
      const rangeHeader = openOptions.range
      let range: { start: number; end: number } | null = null
      if (rangeHeader) {
        if (resource.acceptRanges === false) {
          network.log.push({ url, method: 'GET', headers: { ...(openOptions.headers ?? {}) }, range: rangeHeader })
          range = null
        } else {
          const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
          if (!match) throw new BackendError('NETWORK', `非法 Range：${rangeHeader}`)
          const start = match[1] ? Number(match[1]) : Math.max(0, resource.size - Number(match[2]))
          const end = match[1] ? (match[2] ? Math.min(Number(match[2]), resource.size - 1) : resource.size - 1) : resource.size - 1
          range = { start, end }
        }
      }
      network.log.push({ url, method: 'GET', headers: { ...(openOptions.headers ?? {}) }, range: rangeHeader })
      return new MockByteStream(network, resource, range, { ...(openOptions.headers ?? {}) }, openOptions.signal)
    },
    async proxyFor() { return '' },
    path: pathOps,
    files,
    archive,
    processes,
  }

  return {
    adapter, network, archives, processes, root,
    async cleanup() { network.abortAll(); await fs.rm(root, { force: true, recursive: true }).catch(() => undefined) },
  }
}

class MockWriter implements ProgressWriter {
  private handle: fs.FileHandle | null = null
  /** 正在进行的打开操作：多个连接同时首次写入时共用它（与真实适配层一致，否则会各开一个句柄、多出来的没人关） */
  private opening: Promise<fs.FileHandle> | null = null
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  private open(): Promise<fs.FileHandle> {
    if (this.handle) return Promise.resolve(this.handle)
    if (!this.opening) {
      this.opening = (async () => {
        // 与真实适配层一致：已存在的文件以读写方式打开、不截断（续传要保留已写入的分片）；不存在才创建
        await fs.mkdir(nodePath.dirname(this.path), { recursive: true })
        const handle = await fs.open(this.path, 'r+').catch(async (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return fs.open(this.path, 'w+')
          throw error
        })
        this.handle = handle
        return handle
      })().finally(() => { this.opening = null })
    }
    return this.opening
  }

  async write(position: number, bytes: Uint8Array): Promise<void> {
    const handle = await this.open()
    await handle.write(bytes, 0, bytes.length, position)
  }

  async ensureLength(length: number): Promise<void> {
    const handle = await this.open()
    await handle.truncate(length)
  }

  async close(): Promise<void> {
    // 打开还没完成就关闭：等它打开再关，否则这个句柄就漏了
    if (this.opening) await this.opening.catch(() => undefined)
    const handle = this.handle
    this.handle = null
    await handle?.close()
  }
}

export class MockArchiveRegistry {
  /** 主卷 basename（小写）→ 解压清单 */
  readonly specs = new Map<string, MockArchiveSpec>()
  readonly extractions: Array<{ archive: string; outputDir: string }> = []

  register(mainVolumeName: string, spec: MockArchiveSpec): void {
    this.specs.set(mainVolumeName.toLowerCase(), spec)
  }

  lookup(archivePath: string): MockArchiveSpec | undefined {
    return this.specs.get(nodePath.basename(archivePath).toLowerCase())
  }
}

export class MockProcessTable implements ProcessOps {
  readonly launched: LaunchedProcess[] = []
  terminated: number[] = []
  private counter = 4000 + Math.floor(Math.random() * 1000)

  async launch(options: { exe: string; cwd: string }): Promise<LaunchedProcess> {
    const processInfo: LaunchedProcess = { pid: this.counter++, startedAt: Date.now(), image: options.exe }
    this.launched.push(processInfo)
    return processInfo
  }

  async identity(pid: number): Promise<{ startedAt: number; image: string } | null> {
    if (this.terminated.includes(pid)) return null
    return this.launched.find(entry => entry.pid === pid) ?? null
  }

  async terminate(pid: number, expected: { startedAt: number; image: string }): Promise<'terminated' | 'gone' | 'refused'> {
    const current = await this.identity(pid)
    // 进程已不存在（自己退出了）、PID 被别的进程占用，都算 gone：都不是"没能结束"
    if (!current) return 'gone'
    if (current.startedAt !== expected.startedAt || current.image !== expected.image) return 'gone'
    this.terminated.push(pid)
    return 'terminated'
  }
}
