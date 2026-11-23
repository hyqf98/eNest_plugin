/**
 * 真实适配层：undici 网络、真实文件、runtime 里的 7z、真实子进程。
 *
 * 安全与正确性约定：
 * - 重定向手动跟随，跨 origin 时清掉 cookie / authorization，凭据不外泄给第三方 CDN；
 * - TLS 证书正常校验，不关闭；
 * - 7z 子进程登记到宿主（关闭插件时会被回收），无控制台窗口，输出按 GBK 解码；
 * - 启动游戏需要管理员权限时走系统提权；结束进程前核对身份（启动时间 + 映像路径），避免 PID 复用误杀。
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { Agent, EnvHttpProxyAgent, ProxyAgent, request, type Dispatcher } from 'undici'
import { resolveProxy, trackProcess, untrackProcess } from '../runtime.ts'
import { abortError } from '../util.ts'
import { BackendError, type Adapter, type ArchiveOps, type ByteStream, type ExtractOptions, type ExtractResult, type FileOps, type HttpRequest, type LaunchedProcess, type PathOps, type ProcessOps, type ProgressWriter, type RawResponse } from './types.ts'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 10
const CREDENTIAL_HEADERS = ['cookie', 'authorization', 'proxy-authorization']
const MAX_TEXT_BYTES = 16 * 1024 * 1024
const IS_WINDOWS = process.platform === 'win32'

export const pathOps: PathOps = {
  join: (...parts) => nodePath.join(...parts),
  resolve: value => nodePath.resolve(value),
  dirname: value => nodePath.dirname(value),
  basename: value => nodePath.basename(value),
  extname: value => nodePath.extname(value),
  isAbsolute: value => nodePath.isAbsolute(value),
}

/* ---------------- 代理 ---------------- */

const hasProxyEnv = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(key => Boolean(process.env[key]))
// 宿主启动后端时已把当前生效的代理注入环境变量，这里跟随它，不绕过用户的代理配置。
const envAgent: Dispatcher | undefined = hasProxyEnv ? new EnvHttpProxyAgent() : undefined
const directAgent = new Agent({ connect: { timeout: 30_000 } })
const explicitAgents = new Map<string, Dispatcher>()

function agentFor(proxyUrl: string): Dispatcher {
  if (!proxyUrl) return envAgent ?? directAgent
  let agent = explicitAgents.get(proxyUrl)
  if (!agent) {
    agent = new ProxyAgent(proxyUrl)
    explicitAgents.set(proxyUrl, agent)
  }
  return agent
}

/**
 * 从宿主解析出的 PAC 风格结果里取出代理地址，返回 undici ProxyAgent 可用的 URL，直连返回空串。
 * PAC 的写法是 "SCHEME host:port; DIRECT"，scheme 与主机用空格分隔：
 *   "PROXY 127.0.0.1:7890; DIRECT"   → http://127.0.0.1:7890（PROXY 即 HTTP 代理）
 *   "HTTPS proxy.example:443"        → https://proxy.example:443
 *   "SOCKS5 127.0.0.1:1080"          → socks5://127.0.0.1:1080
 * 也兼容宿主直接给出完整 URL 的情况（"http://127.0.0.1:7890"）。
 */
export function parseProxyLine(line: string): string {
  const first = String(line ?? '').split(';').map(part => part.trim()).find(part => part && !/^direct$/i.test(part))
  if (!first) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(first)) return first
  const match = /^([a-z0-9]+)(?:\s+)(\S+)$/i.exec(first)
  if (!match) return ''
  const rawScheme = match[1].toLowerCase()
  const scheme = rawScheme === 'proxy' ? 'http' : rawScheme
  if (!['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'].includes(scheme)) return ''
  const host = scheme.startsWith('socks') ? match[2] : (match[2].includes(':') ? match[2] : `${match[2]}:80`)
  return `${scheme}://${host}`
}

async function dispatcherFor(url: string): Promise<Dispatcher> {
  let resolved = ''
  try {
    resolved = await resolveProxy(url)
  } catch {
    // 宿主解析失败时退回环境变量代理。
  }
  const proxyUrl = parseProxyLine(resolved)
  return agentFor(proxyUrl)
}

/* ---------------- 普通请求 ---------------- */

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key) || typeof value !== 'string' || value.length > 8192) continue
    out[key.toLowerCase()] = value
  }
  return out
}

function flattenHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase()
    // set-cookie 不能用逗号合并（cookie 值本身可含逗号），单独经 setCookies 逐条给出。
    if (lower === 'set-cookie') continue
    out[lower] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
  }
  return out
}

/** 每条 Set-Cookie 原样一项 */
function splitCookies(raw: Record<string, string | string[] | undefined>): string[] {
  const value = raw['set-cookie'] ?? raw['Set-Cookie']
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' && value ? [value] : []
}

async function readBody(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new BackendError('NETWORK', `响应超过 ${maxBytes} 字节上限`)
    chunks.push(buffer)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(250, ms))
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * 发请求并读完响应体。manualRedirect 时遇到 3xx 直接返回（带 location），由调用方逐跳处理；
 * 否则自动跟随，跨 origin 时清掉凭据头。
 */
export async function requestText(options: HttpRequest): Promise<RawResponse> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const maxBytes = options.maxBytes ?? MAX_TEXT_BYTES
  let currentUrl = options.url
  let headers = normalizeHeaders(options.headers)
  if (!headers['user-agent']) headers['user-agent'] = USER_AGENT
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const dispatcher = await dispatcherFor(currentUrl)
    let response: Awaited<ReturnType<typeof request>>
    try {
      response = await request(currentUrl, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        dispatcher,
        signal: timeoutSignal(timeoutMs, options.signal),
      })
    } catch (error) {
      throw toNetworkError(error, currentUrl)
    }
    if (REDIRECT_STATUS.has(response.statusCode)) {
      const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location
      if (options.manualRedirect) {
        const body = await readBody(response.body, 64 * 1024).catch(() => new Uint8Array())
        return { status: response.statusCode, headers: flattenHeaders(response.headers), setCookies: splitCookies(response.headers), location: location ? new URL(location, currentUrl).toString() : '', body }
      }
      await response.body.dump().catch(() => undefined)
      if (!location) throw new BackendError('NETWORK', '重定向响应缺少 Location')
      const nextUrl = new URL(location, currentUrl).toString()
      if (!/^https?:\/\//i.test(nextUrl)) throw new BackendError('NETWORK', '重定向协议不受支持')
      if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
        for (const name of CREDENTIAL_HEADERS) delete headers[name]
      }
      currentUrl = nextUrl
      continue
    }
    const body = await readBody(response.body, maxBytes).catch(error => { throw toNetworkError(error, currentUrl) })
    return { status: response.statusCode, headers: flattenHeaders(response.headers), setCookies: splitCookies(response.headers), location: '', body }
  }
  throw new BackendError('NETWORK', '重定向次数过多')
}

/** undici 的数字错误码：20 = 调用方中止，23 = 超时 */
const UNDICI_ABORTED = 20
const UNDICI_TIMEOUT = 23

function toNetworkError(error: unknown, url: string): Error {
  if (error instanceof BackendError) return error
  const err = error as { name?: string; code?: unknown; errno?: unknown; message?: string; cause?: { code?: string; message?: string } }
  const name = err?.name ?? ''
  const causeCode = err?.cause?.code ?? ''
  const rawCode = typeof err?.code === 'number' ? err.code : String(err?.code ?? '')
  const aborted = name === 'AbortError' || rawCode === UNDICI_ABORTED || causeCode === 'UND_ERR_ABORTED'
  if (aborted) return abortError()
  const timedOut = name === 'TimeoutError' || rawCode === UNDICI_TIMEOUT || causeCode === 'UND_ERR_HEADERS_TIMEOUT' || causeCode === 'UND_ERR_BODY_TIMEOUT' || causeCode === 'UND_ERR_CONNECT_TIMEOUT' || causeCode === 'ETIMEDOUT'
  if (timedOut) return Object.assign(new Error(`请求超时：${url.slice(0, 120)}`), { name: 'TimeoutError', code: 'ETIMEDOUT' })
  const code = causeCode || rawCode || ''
  const detail = code || err?.cause?.message || (error instanceof Error ? error.message : String(error))
  return Object.assign(new Error(`请求失败 ${detail}：${url.slice(0, 120)}`), { code: code || 'ENETWORK' })
}

/* ---------------- 流式下载 ---------------- */

class UndiciByteStream implements ByteStream {
  readonly status: number
  readonly headers: Record<string, string>
  readonly setCookies: string[]
  private readonly response: Awaited<ReturnType<typeof request>>
  private readonly reader: AsyncIterator<Uint8Array>
  /** 这次请求的中止控制器：abort() 用它真正掐断连接 */
  private readonly controller: AbortController
  /** 流结束（读完或中止）时调用一次：openStream 用它摘掉挂在外部信号上的监听 */
  private readonly onEnd: () => void
  private closed = false

  constructor(status: number, headers: Record<string, string>, setCookies: string[], response: Awaited<ReturnType<typeof request>>, controller: AbortController, onEnd: () => void) {
    this.status = status
    this.headers = headers
    this.setCookies = setCookies
    this.response = response
    this.controller = controller
    this.onEnd = onEnd
    this.reader = response.body[Symbol.asyncIterator]()
  }

  async read(): Promise<{ bytes: Uint8Array; at: number } | null> {
    if (this.closed) return null
    try {
      const next = await this.reader.next()
      if (next.done) { this.finish(false); return null }
      return { bytes: new Uint8Array(next.value), at: Date.now() }
    } catch (error) {
      this.finish(false)
      throw error
    }
  }

  /**
   * 中止：掐断连接。暂停、删除、关闭插件时都会走到这里。
   * 不能用 body.dump()：它的语义是"把剩下的数据读完再丢"，连接会一直开着把整个文件下完，
   * 暂停之后仍在占带宽和云盘的下载额度。
   */
  abort(): void { this.finish(true) }

  private finish(abort: boolean): void {
    if (this.closed) return
    this.closed = true
    this.onEnd()
    if (abort) this.controller.abort()
    else void this.response.body.dump().catch(() => undefined)
  }
}

async function openStream(url: string, range?: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<ByteStream> {
  const h = normalizeHeaders(headers)
  if (!h['user-agent']) h['user-agent'] = USER_AGENT
  let currentUrl = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const dispatcher = await dispatcherFor(currentUrl)
    let response: Awaited<ReturnType<typeof request>>
    // 自己的控制器：外部中止、超时、以及之后的 stream.abort() 都经过它
    const controller = new AbortController()
    const timeout = AbortSignal.timeout(60_000)
    const onOuterAbort = (): void => controller.abort()
    const onTimeout = (): void => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    timeout.addEventListener('abort', onTimeout, { once: true })
    try {
      response = await request(currentUrl, {
        method: 'GET',
        headers: range ? { ...h, range } : h,
        dispatcher,
        signal: controller.signal,
      })
    } catch (error) {
      signal?.removeEventListener('abort', onOuterAbort)
      throw toNetworkError(error, currentUrl)
    }
    if (REDIRECT_STATUS.has(response.statusCode)) {
      const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location
      await response.body.dump().catch(() => undefined)
      controller.abort()
      signal?.removeEventListener('abort', onOuterAbort)
      if (!location) throw new BackendError('NETWORK', '重定向响应缺少 Location')
      const nextUrl = new URL(location, currentUrl).toString()
      if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
        for (const name of CREDENTIAL_HEADERS) delete h[name]
        // 直链通常会 302 到 CDN：CDN 接受 Range，但带着旧头的 Range 语义不变，保留。
      }
      currentUrl = nextUrl
      continue
    }
    const detach = (): void => { signal?.removeEventListener('abort', onOuterAbort); timeout.removeEventListener('abort', onTimeout) }
    return new UndiciByteStream(response.statusCode, flattenHeaders(response.headers), splitCookies(response.headers), response, controller, detach)
  }
  throw new BackendError('NETWORK', '重定向次数过多')
}

/* ---------------- 文件 ---------------- */

const files: FileOps = {
  async ensureDir(path) { await fs.mkdir(path, { recursive: true }) },
  async isDirectory(path) { try { return (await fs.stat(path)).isDirectory() } catch { return false } },
  async stat(path) {
    try {
      const s = await fs.stat(path)
      return { size: s.size, isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs }
    } catch { return null }
  },
  async remove(path) { await fs.rm(path, { force: true, recursive: true }) },
  async removeFile(path) { await fs.rm(path, { force: true }) },
  async removeDir(path) { await fs.rm(path, { force: true, recursive: true }) },
  async rename(from, to) {
    await fs.mkdir(nodePath.dirname(to), { recursive: true })
    await fs.rename(from, to)
  },
  async readFile(path, maxBytes) {
    const handle = await fs.open(path, 'r')
    try {
      const stat = await handle.stat()
      const length = maxBytes ? Math.min(stat.size, maxBytes) : stat.size
      const buffer = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, read)
        if (!bytesRead) break
        read += bytesRead
      }
      return new Uint8Array(buffer.subarray(0, read))
    } finally {
      await handle.close()
    }
  },
  async writeFile(path, bytes) {
    await fs.mkdir(nodePath.dirname(path), { recursive: true })
    await fs.writeFile(path, bytes)
  },
  async listDir(path) {
    const entries = await fs.readdir(path, { withFileTypes: true })
    const out: Array<{ name: string; isDirectory: boolean; size: number }> = []
    for (const entry of entries) {
      let size = 0
      try { size = (await fs.stat(nodePath.join(path, entry.name))).size } catch { /* 已被移走 */ }
      out.push({ name: entry.name, isDirectory: entry.isDirectory(), size })
    }
    return out
  },
  async freeSpace(path) {
    if (!IS_WINDOWS) return null
    // 用 .NET DriveInfo 取可用空间（比 Get-PSDrive 快，且直接接受路径）；失败返回 null，调用方按"无法判断"处理。
    return new Promise(resolve => {
      const escaped = path.replace(/'/g, "''")
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `([System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot('${escaped}'))).AvailableFreeSpace`],
        { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
          if (error) { resolve(null); return }
          const value = Number(stdout.trim())
          resolve(Number.isFinite(value) && value >= 0 ? value : null)
        })
    })
  },
  async openWriter(path) { return new NodeWriter(path) },
  async concatFiles(sources, target, signal, onProgress) {
    await fs.mkdir(nodePath.dirname(target), { recursive: true })
    const total = (await Promise.all(sources.map(async source => (await fs.stat(source)).size))).reduce((sum, size) => sum + size, 0)
    const CHUNK = 8 * 1024 * 1024
    const output = await fs.open(target, 'w')
    let copied = 0
    try {
      const buffer = Buffer.alloc(CHUNK)
      for (const source of sources) {
        if (signal?.aborted) throw abortError()
        const input = await fs.open(source, 'r')
        try {
          for (;;) {
            if (signal?.aborted) throw abortError()
            const { bytesRead } = await input.read(buffer, 0, CHUNK, null)
            if (bytesRead === 0) break
            let written = 0
            while (written < bytesRead) {
              const result = await output.write(buffer, written, bytesRead - written)
              written += result.bytesWritten
            }
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
  async reveal(path) {
    if (!IS_WINDOWS) return
    await new Promise<void>(resolve => {
      execFile('explorer.exe', ['/select,', path], { windowsHide: true }, () => resolve())
    })
  },
}

class NodeWriter implements ProgressWriter {
  private handle: fs.FileHandle | null = null
  /** 正在进行的打开操作。多个连接同时第一次写入时共用它，否则每个连接都会打开一个句柄，多出来的那些没人关 */
  private opening: Promise<fs.FileHandle> | null = null
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  private open(): Promise<fs.FileHandle> {
    if (this.handle) return Promise.resolve(this.handle)
    if (!this.opening) {
      this.opening = (async () => {
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
    let written = 0
    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, position + written)
      written += bytesWritten
    }
  }

  async ensureLength(length: number): Promise<void> {
    const handle = await this.open()
    const stat = await handle.stat()
    if (stat.size < length) await handle.truncate(length)
  }

  async close(): Promise<void> {
    // 打开还没完成就关闭（下载刚开始即被暂停）：等它打开再关，否则这个句柄就漏了
    const pending = this.opening
    if (pending) { await pending.catch(() => undefined) }
    const handle = this.handle
    this.handle = null
    await handle?.close()
  }
}

/* ---------------- 解压（7-Zip） ---------------- */

/** 定位当前平台的 7z 可执行文件：runtime/7zip/<target>/ */
export function locateSevenZip(packagePath: string): string {
  const target = IS_WINDOWS ? 'win32-x64' : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64') : 'linux-x64'
  const name = IS_WINDOWS ? '7z.exe' : '7zz'
  return nodePath.join(packagePath, 'runtime', '7zip', target, name)
}

function decodeToolOutput(buffer: Buffer): string {
  // 7-Zip 在中文 Windows 上按 GBK 输出；先试 UTF-8，出现替换符再按 GBK 解。
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return utf8
  }
}

/** 7z 进程的退出码：0 成功；1 警告（非致命）；其余失败 */
const runTool = (sevenZip: string, args: string[], signal: AbortSignal | undefined, onOutput: () => void): Promise<{ code: number; stdout: string; stderr: string; aborted: boolean }> => {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(sevenZip, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    // 进度输出会持续很多，只保留末尾若干字节用于错误说明，避免长时间解压时内存无限增长。
    const TAIL_BYTES = 16 * 1024
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let tracked = false
    let settled = false
    let aborted = false
    const push = (list: Buffer[], chunk: Buffer): number => {
      list.push(chunk)
      let total = (list === out ? outBytes : errBytes) + chunk.length
      while (list.length > 1 && total > TAIL_BYTES) total -= (list.shift() as Buffer).length
      return total
    }
    const finish = (run: () => void): void => { if (settled) return; settled = true; run() }
    if (child.pid) {
      trackProcess(child.pid).then(() => { tracked = true }).catch(() => undefined)
    }
    child.stdout?.on('data', (chunk: Buffer) => { outBytes = push(out, chunk); onOutput() })
    child.stderr?.on('data', (chunk: Buffer) => { errBytes = push(err, chunk); onOutput() })
    child.on('error', error => { finish(() => reject(new BackendError('EXTRACT', `解压程序启动失败：${error.message}`))) })
    child.on('close', code => {
      const done = (): void => finish(() => resolve({ code: code ?? -1, stdout: decodeToolOutput(Buffer.concat(out)), stderr: decodeToolOutput(Buffer.concat(err)), aborted }))
      if (child.pid && tracked) untrackProcess(child.pid).finally(done)
      else done()
    })
    if (signal) {
      if (signal.aborted) aborted = true
      else signal.addEventListener('abort', () => { aborted = true; try { child.kill() } catch { /* 已退出 */ } }, { once: true })
    }
  })
}

const archive: ArchiveOps = {
  async available() {
    if (!currentPackagePath) return false
    try { await fs.access(locateSevenZip(currentPackagePath)); return true } catch { return false }
  },
  async extract(options: ExtractOptions): Promise<ExtractResult> {
    if (!currentPackagePath) throw new BackendError('EXTRACT', '缺少解压程序')
    const sevenZip = locateSevenZip(currentPackagePath)
    // x：保留目录结构；-aoa：覆盖；-y：所有询问答是；
    // -bso0：不输出普通信息；-bsp1：进度输出到 stdout（用于卡死检测）；-bb0：不输出文件名列表
    const args = ['x', options.archive, `-o${options.outputDir}`, '-y', '-aoa', '-bso0', '-bsp1', '-bb0']
    const result = await runTool(sevenZip, args, options.signal, () => options.onProgress?.())
    if (result.aborted) throw abortError()
    const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-6).join('\n')
    return { exitCode: result.code, tail }
  },
}

let currentPackagePath = ''

export function setPackagePath(value: string): void {
  currentPackagePath = value
}

/* ---------------- 进程 ---------------- */

function runPowerShell(script: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return }
      resolve(stdout)
    })
  })
}

/** 进程身份：启动时间（毫秒）+ 映像完整路径 */
export async function readProcessIdentity(pid: number): Promise<{ startedAt: number; image: string } | null> {
  if (!IS_WINDOWS) {
    try { process.kill(pid, 0); return { startedAt: 0, image: '' } } catch { return null }
  }
  try {
    const stdout = await runPowerShell(
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}"; if ($p) { $image = $p.ExecutablePath; if (-not $image) { $image = (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).Path }; ` +
      `$start = (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks; Write-Output ("{0}|{1}" -f $start, $image) }`)
    const line = stdout.trim()
    if (!line || !line.includes('|')) return null
    const [ticks, image] = line.split('|')
    const startTicks = Number(ticks)
    if (!Number.isFinite(startTicks) || startTicks <= 0) return null
    return { startedAt: Math.floor(startTicks / 10_000), image }
  } catch {
    return null
  }
}

const processes: ProcessOps = {
  async launch(options): Promise<LaunchedProcess> {
    const exe = options.exe
    let isFile = false
    try { isFile = (await fs.stat(exe)).isFile() } catch { throw new BackendError('LAUNCH', `游戏文件不存在，可能解压未完成或已被移动：${exe}`) }
    if (!isFile) throw new BackendError('LAUNCH', `不是可执行文件：${exe}`)
    const outcome = await new Promise<number | 'elevation-required'>((resolve, reject) => {
      // 普通启动（不提权）。detached + unref：游戏不随插件后端退出而被带走。
      const child = spawn(exe, [], { cwd: options.cwd, detached: true, stdio: 'ignore' })
      const errno = (error: NodeJS.ErrnoException): number => typeof error.errno === 'number' ? error.errno : Number(error.code) || 0
      child.once('error', error => {
        // ERROR_ELEVATION_REQUIRED = 740：可执行文件清单要求管理员权限，交给系统提权（UAC）。
        if (errno(error) === 740) { resolve('elevation-required'); return }
        reject(new BackendError('LAUNCH', `启动失败：${error.message}`))
      })
      child.once('spawn', () => { child.unref(); resolve(child.pid ?? 0) })
    })
    if (outcome === 'elevation-required') {
      if (!IS_WINDOWS) throw new BackendError('LAUNCH', '启动失败：需要管理员权限')
      try {
        await runPowerShell(`Start-Process -FilePath '${exe.replace(/'/g, "''")}' -WorkingDirectory '${options.cwd.replace(/'/g, "''")}' -Verb RunAs`, 120_000)
      } catch (error) {
        throw new BackendError('LAUNCH', `管理员启动失败或已取消：${error instanceof Error ? error.message : String(error)}`)
      }
      // 提权启动的进程拿不到 pid（由高完整性进程创建），只能显示为"已启动"，无法再由插件关闭。
      return { pid: 0, startedAt: Date.now(), image: exe }
    }
    const pid = outcome
    // 读取身份；读不到也允许继续，但后续"关闭游戏"会因身份不符而拒绝。
    const identity = await readProcessIdentity(pid)
    return { pid, startedAt: identity?.startedAt ?? 0, image: identity?.image ?? exe }
  },

  async identity(pid) { return readProcessIdentity(pid) },

  async terminate(pid, expected): Promise<'terminated' | 'gone' | 'refused'> {
    if (!Number.isSafeInteger(pid) || pid <= 4) return 'refused'
    const current = await readProcessIdentity(pid)
    // 读不到身份 = 进程已经不在了。这种情况不是"没能结束"，不能让界面显示"仍在运行"。
    if (!current) return 'gone'
    // 身份核对：启动时间或映像路径对不上，说明 PID 已被别的进程复用。我们启动的那个早就退出了，
    // 同样算 gone（只是不去碰这个 PID）；refused 只留给"身份对得上却没能结束"的情况。
    if (expected.startedAt && current.startedAt && Math.abs(current.startedAt - expected.startedAt) > 2000) return 'gone'
    if (expected.image && current.image && current.image.toLowerCase() !== expected.image.toLowerCase()) return 'gone'
    if (!IS_WINDOWS) { try { process.kill(pid, 'SIGTERM') } catch { return 'refused' } return 'terminated' }
    try {
      await runPowerShell(`Stop-Process -Id ${pid} -Force -ErrorAction Stop`)
      return 'terminated'
    } catch {
      return 'refused'
    }
  },
}

/* ---------------- 组装 ---------------- */

export function createLiveAdapter(): Adapter {
  return {
    request: requestText,
    async openStream(url, openOptions = {}) {
      // 不支持 Range 的服务器会对带 Range 的请求回 200（整文件）；交给调用方按状态码判断降级。
      return openStream(url, openOptions.range, openOptions.headers, openOptions.signal)
    },
    async proxyFor(url) {
      try { return parseProxyLine(await resolveProxy(url)) } catch { return '' }
    },
    path: pathOps,
    files,
    archive,
    processes,
  }
}
