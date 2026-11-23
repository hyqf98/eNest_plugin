/**
 * 适配层接口：业务逻辑（下载器、安装、任务状态机）只依赖这里的类型，
 * 不直接碰 undici / node:fs / 子进程。这样同一套业务代码既能接真实实现（live），
 * 也能接模拟实现（mock，用于单测：假网络、临时目录里的假字节、假解压、假进程）。
 */

export interface HttpRequest {
  url: string
  method?: 'GET' | 'POST' | 'HEAD'
  headers?: Record<string, string>
  body?: string | Uint8Array
  /** 整个请求（含读完响应体）的墙钟上限 */
  timeoutMs?: number
  /** 响应体上限，超过即报错 */
  maxBytes?: number
  /** 不自动跟随重定向，由调用方自己处理每一跳 */
  manualRedirect?: boolean
  signal?: AbortSignal
}

export interface RawResponse {
  status: number
  /** 响应头，键小写；多值头用 ", " 连接（set-cookie 除外，见 setCookies） */
  headers: Record<string, string>
  /** 每一条 Set-Cookie 原样一项，不合并（登录链路需要逐条解析 Domain / Path / HttpOnly） */
  setCookies: string[]
  /** 未跟随重定向时的下一跳地址（绝对地址） */
  location: string
  /** 响应体字节 */
  body: Uint8Array
}

export interface StreamedChunk {
  bytes: Uint8Array
  /** 收到这一块的时刻（毫秒） */
  at: number
}

/** 流式下载句柄：调用方按需拉取字节块 */
export interface ByteStream {
  /** HTTP 状态码 */
  status: number
  headers: Record<string, string>
  setCookies: string[]
  /** 是否还有下一块 */
  read(): Promise<StreamedChunk | null>
  /** 立即中止底层连接 */
  abort(): void
}

export interface OpenStreamOptions {
  /** "bytes=a-b"；不传表示整文件 */
  range?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface ProgressWriter {
  /** 把字节写到文件的指定偏移；等待真正落盘后返回 */
  write(position: number, bytes: Uint8Array): Promise<void>
  /** 确保文件长度至少为 length */
  ensureLength(length: number): Promise<void>
  close(): Promise<void>
}

export interface Adapter {
  /** 普通请求：读完整个响应体 */
  request(options: HttpRequest): Promise<RawResponse>
  /** 打开流式下载连接 */
  openStream(url: string, options?: OpenStreamOptions): Promise<ByteStream>
  /** 解析某条直链应当使用的代理地址，返回空串表示直连 */
  proxyFor(url: string): Promise<string>

  path: PathOps
  files: FileOps
  archive: ArchiveOps
  processes: ProcessOps
}

export interface PathOps {
  join(...parts: string[]): string
  resolve(value: string): string
  dirname(value: string): string
  basename(value: string): string
  extname(value: string): string
  isAbsolute(value: string): boolean
}

export interface FileOps {
  ensureDir(path: string): Promise<void>
  /** 判断路径是否存在且是目录 */
  isDirectory(path: string): Promise<boolean>
  stat(path: string): Promise<{ size: number; isDirectory: boolean; mtimeMs: number } | null>
  remove(path: string): Promise<void>
  /** 删除文件；文件不存在视为成功 */
  removeFile(path: string): Promise<void>
  /** 递归删除目录 */
  removeDir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  readFile(path: string, maxBytes?: number): Promise<Uint8Array>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  listDir(path: string): Promise<Array<{ name: string; isDirectory: boolean; size: number }>>
  /** 目标目录的可用字节数；无法获取返回 null */
  freeSpace(path: string): Promise<number | null>
  /** 以随机访问方式打开文件用于写入分片 */
  openWriter(path: string): Promise<ProgressWriter>
  /**
   * 把多个文件按顺序流式拼接成一个文件（用于 WinZip 分卷 .z01…zNN + .zip 的回退解压）。
   * 逐块读写，不把任何文件整体读入内存；目标已存在则覆盖。
   */
  concatFiles(sources: string[], target: string, signal?: AbortSignal, onProgress?: (copied: number, total: number) => void): Promise<void>
  /** 在文件管理器中显示该路径（仅 live 实现有意义） */
  reveal(path: string): Promise<void>
}

export interface ExtractOptions {
  /** 主卷路径；多卷压缩包只传主卷 */
  archive: string
  /** 解压目标目录 */
  outputDir: string
  signal?: AbortSignal
  /** 每次有输出进展时回调（用于卡死检测） */
  onProgress?: () => void
}

export interface ExtractResult {
  /** 0 成功；1 警告（非致命）；其余为失败 */
  exitCode: number
  /** 输出末尾若干行，用于错误说明 */
  tail: string
}

export interface ArchiveOps {
  /** 是否具备解压能力（live：runtime 里有 7z；mock：恒为 true） */
  available(): Promise<boolean>
  extract(options: ExtractOptions): Promise<ExtractResult>
}

export interface LaunchOptions {
  exe: string
  cwd: string
  signal?: AbortSignal
}

export interface LaunchedProcess {
  pid: number
  /** 进程启动时刻（毫秒），用于之后核对身份 */
  startedAt: number
  /** 映像完整路径，用于之后核对身份 */
  image: string
}

export interface ProcessOps {
  launch(options: LaunchOptions): Promise<LaunchedProcess>
  /** 读取进程身份；进程已不存在返回 null */
  identity(pid: number): Promise<{ startedAt: number; image: string } | null>
  /**
   * 核对身份后结束进程。
   * - terminated：由我们结束的
   * - gone：不用结束。进程已经自己退出，或 PID 已被别的进程占用（我们启动的那个早已不在），不去碰这个 PID
   * - refused：身份对得上却没能结束，进程仍在运行（例如系统拒绝访问）
   */
  terminate(pid: number, expected: { startedAt: number; image: string }): Promise<'terminated' | 'gone' | 'refused'>
}

/** 带错误码的后端错误 */
export class BackendError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

export function fail(code: string, message: string): never {
  throw new BackendError(code, message)
}
