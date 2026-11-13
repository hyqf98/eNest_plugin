/**
 * markdown v2 后端 —— utilityProcess 入口。
 * 职责：本地 .md 持续读写（原子写 + watch）、目录树、最近文件、速记收件箱、
 * 图床（本地 assets / PicList / GitHub / 自定义 JS 沙箱）、用户主题索引、图片资产索引。
 * 零 npm 依赖：全部 Node 内置 + Node 22 原生 fetch/FormData。
 *
 * 存储模型（统一存储，不再自管 ~/.eNest/plugins 目录）：
 *  - 业务数据（config / recent / inbox / themes）全部走 host.request 的
 *    storage.get / storage.set，落宿主统一插件 KV；
 *  - 图片缓存与「存本地」图片是文件型数据，写在宿主授权数据目录
 *    {appDataPath}/markdown/（cache/ 可重建、assets/ 为业务文件）；
 *  - token 不进 KV 明文：config 只保存 vault secretRef，上传时经
 *    secret.resolve 解出使用，明文不落盘、不回渲染层。
 *
 * 安全约定：
 *  - 路径越界一律拒绝：文件只允许打开用户经选择器/拖拽授权过的路径或其所在工作根内；
 *  - 自定义上传脚本在 node:vm 中执行，无 require/process/fs，15s 超时；
 *  - 凭证只经宿主密钥库（vault），脚本明文与错误消息不带 token。
 */
import { createHash, webcrypto } from 'node:crypto'
import { watch } from 'node:fs'
import { readFile, writeFile, mkdir, readdir, stat, rename, rm, copyFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, basename, extname, isAbsolute, sep } from 'node:path'
import vm from 'node:vm'

type Request = {
  type?: string
  id?: number
  pluginId?: string
  generation?: number
  wcId?: number
  context?: unknown
  method?: string
  args?: unknown[]
}
interface ParentPort {
  on(event: 'message', listener: (message: { data: Request & { ok?: boolean; data?: unknown; error?: string } }) => void): void
  postMessage(message: unknown): void
}
const maybePort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!maybePort) throw new Error('This entry requires the eNest utility process')
const port: ParentPort = maybePort

const PLUGIN_ID = 'com.github.eNest.markdown'
/** init 握手后冻结的宿主上下文（appDataPath 为宿主授权数据目录） */
let appDataPath = ''
let owner: string | undefined

/* ---------------- 宿主控制通道（storage / secret / log） ---------------- */
interface PendingHost {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
const HOST_TIMEOUT_MS = 30_000
let hostSequence = 0
const hostControls = new Map<number, PendingHost>()

function assertReady(): void {
  if (!owner || !appDataPath) throw new Error('后端尚未就绪，请稍后重试')
}
/** host.request：storage.get/set、secret.resolve 等宿主能力，带超时与在途表 */
function hostRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  assertReady()
  if (hostControls.size >= 64) return Promise.reject(new Error('后端控制请求过多，请稍后重试'))
  const id = ++hostSequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { hostControls.delete(id); reject(new Error('宿主控制请求超时')) }, HOST_TIMEOUT_MS)
    timer.unref()
    hostControls.set(id, { resolve, reject, timer })
    try {
      port.postMessage({ type: 'host.request', id, method, params })
    } catch (error) {
      hostControls.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
const storageGet = (key: string): Promise<unknown> => hostRequest('storage.get', { key })
async function storageSet(key: string, value: unknown): Promise<void> {
  await hostRequest('storage.set', { key, value })
}
/** 解 vault 引用；未配置（空 ref）返回空串 */
async function resolveSecret(ref: string): Promise<string> {
  if (!ref) return ''
  const value = await hostRequest('secret.resolve', { ref })
  return typeof value === 'string' ? value : ''
}

/* ---------------- 数据根 ---------------- */
/** 插件文件数据目录：{appDataPath}/markdown/（宿主授权数据目录，只放 cache 与 assets） */
function dataLocalRoot(): string {
  assertReady()
  return join(appDataPath, 'markdown')
}
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/* ---------------- 路径授权 ---------------- */
/** 已授权的文件/目录路径集合（选择器 pick/fromDrop → 前端透传 path 登记；或打开的工作根） */
const grantedPaths = new Set<string>()
function normalize(p: string): string {
  return resolve(p)
}
function grant(p: string): void {
  grantedPaths.add(normalize(p))
}
/** 授权检查：路径等于已授权项，或位于已授权目录之内；插件自管目录天然放行 */
function assertAccess(p: string): string {
  const abs = normalize(p)
  if (isPluginManaged(abs)) return abs
  for (const g of grantedPaths) {
    if (abs === g) return abs
    const rel = relative(g, abs)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return abs
  }
  throw new Error('路径未授权：请先通过文件选择器或拖拽打开')
}
/** 图片缓存等插件自管路径天然放行 */
function isPluginManaged(p: string): boolean {
  const abs = normalize(p)
  const root = normalize(dataLocalRoot())
  return abs === root || abs.startsWith(root + sep)
}
/**
 * 持久授权：用户在设置里手输的图片目录，重启后仍需可读（预览要走 assets.readDataUrl）。
 * 记在 config.imageDirs 里（最多 16 个，最近使用的优先），启动时回灌 grantedPaths。
 */
async function grantPersistent(dir: string): Promise<void> {
  const abs = normalize(dir)
  grant(abs)
  const cfg = await loadConfig()
  const next = [abs, ...cfg.imageDirs.filter((item) => normalize(item) !== abs)].slice(0, 16)
  if (next.length !== cfg.imageDirs.length || next.some((item, i) => item !== cfg.imageDirs[i])) {
    cfg.imageDirs = next
    await saveConfig(cfg)
  }
}
/** 启动时回灌持久授权（不阻塞首个请求：调用方 await 一次即可） */
let grantsLoaded: Promise<void> | null = null
function ensureGrantsLoaded(): Promise<void> {
  if (!grantsLoaded) {
    grantsLoaded = (async () => {
      try {
        const cfg = await loadConfig()
        for (const dir of cfg.imageDirs ?? []) grant(dir)
      } catch { /* 配置不可读时按无授权处理 */ }
    })()
  }
  return grantsLoaded
}

/* ---------------- 配置（KV：key 'config'） ---------------- */
interface UploaderConfig {
  active: string
  piclist: { server: string }
  github: { repo: string; branch: string; tokenRef: string; pathTemplate: string; cdn: string; commitMessage: string }
  script: { code: string }
}
interface PluginConfig {
  uploaders: UploaderConfig
  lightTheme: string
  darkTheme: string
  recentRoots: string[]
  migrated: boolean
  /** 本地图片目录（用户手输的原始值，如 `~/图片`）；空 = 插件私有 assets */
  imageDir: string
  /** 持久授权的图片目录（绝对路径）：重启后预览仍可读 */
  imageDirs: string[]
}
const CONFIG_KEY = 'config'
const defaultConfig = (): PluginConfig => ({
  uploaders: {
    active: 'local',
    piclist: { server: 'http://127.0.0.1:36677' },
    github: { repo: '', branch: 'main', tokenRef: '', pathTemplate: 'images/{date}/{name}', cdn: '', commitMessage: 'upload by eNest markdown' },
    script: { code: SCRIPT_TEMPLATE },
  },
  lightTheme: 'enest-minimal',
  darkTheme: 'enest-minimal-dark',
  recentRoots: [],
  migrated: false,
  imageDir: '',
  imageDirs: [],
})
const SCRIPT_TEMPLATE = `// 自定义图床脚本：module.exports = async (ctx) => url 或 { url, markdown }
// ctx = { fileName, mime, bytes(Uint8Array), config, log }；可用全局：fetch/FormData/Blob/Buffer/crypto/URL/TextEncoder
// 返回字符串 url，或 { url, markdown }（markdown 缺省为 "![](url)")
module.exports = async (ctx) => {
  const form = new FormData()
  form.append('smfile', new Blob([ctx.bytes], { type: ctx.mime }), ctx.fileName)
  const res = await fetch('https://smms.app/api/v2/upload', { method: 'POST', headers: { Authorization: \`Basic \${ctx.config.token}\` }, body: form })
  const data = await res.json()
  ctx.log('sm.ms response: ' + data.code)
  return data.data.url
}
`
/** 读取旧字段兼容：token（明文，迁移前遗留）→ 不再使用，仅迁移导出时读取 */
async function loadConfig(): Promise<PluginConfig> {
  const stored = (await storageGet(CONFIG_KEY)) as Partial<PluginConfig> | null ?? {}
  const def = defaultConfig()
  return {
    ...def,
    ...stored,
    uploaders: {
      ...def.uploaders,
      ...(stored.uploaders ?? {}),
      piclist: { ...def.uploaders.piclist, ...(stored.uploaders?.piclist ?? {}) },
      github: { ...def.uploaders.github, ...(stored.uploaders?.github ?? {}) },
      script: { ...def.uploaders.script, ...(stored.uploaders?.script ?? {}) },
    },
  }
}
async function saveConfig(next: PluginConfig): Promise<void> {
  await storageSet(CONFIG_KEY, next)
}
/** 上传用 GitHub 配置：tokenRef → secret.resolve 解出明文 token（只在内存使用） */
async function githubRuntimeConfig(): Promise<{ repo: string; branch: string; token: string; pathTemplate: string; cdn: string; commitMessage: string }> {
  const cfg = await loadConfig()
  const token = await resolveSecret(cfg.uploaders.github.tokenRef)
  return { ...cfg.uploaders.github, token }
}

/* ---------------- 文档 watch ---------------- */
interface WatchEntry {
  path: string
  watcher: ReturnType<typeof watch>
  lastText: string
}
const watches = new Map<string, WatchEntry>()
let currentDocPath = ''
let lastSavedText = ''

/** 自写触发的 watch 事件抑制（保存后 400ms 内的同类变更视为自己） */
let suppressUntil = 0
let suppressPath = ''

async function watchDoc(path: string): Promise<void> {
  const abs = assertAccess(path)
  unwatchDoc(abs)
  const text = await readFile(abs, 'utf8')
  const watcher = watch(abs, { persistent: false }, (event) => {
    if (event !== 'change') {
      // rename/delete：文件可能被替换（保存器原子写或外部重写）
      void recheck(abs)
      return
    }
    if (Date.now() < suppressUntil && suppressPath === abs) {
      suppressUntil = 0
      return
    }
    void emitChange(abs)
  })
  watches.set(abs, { path: abs, watcher, lastText: text })
  currentDocPath = abs
  lastSavedText = text
}
function unwatchDoc(path: string): void {
  const abs = normalize(path)
  const entry = watches.get(abs)
  if (entry) {
    entry.watcher.close()
    watches.delete(abs)
  }
  if (currentDocPath === abs) currentDocPath = ''
}
async function recheck(abs: string): Promise<void> {
  try {
    const text = await readFile(abs, 'utf8')
    const entry = watches.get(abs)
    if (!entry) {
      await watchDoc(abs)
      return
    }
    if (text !== entry.lastText) {
      entry.lastText = text
      port.postMessage({ event: 'doc.changed', data: { path: abs, external: true, deleted: false } })
    }
  } catch {
    port.postMessage({ event: 'doc.changed', data: { path: abs, external: true, deleted: true } })
  }
}
async function emitChange(abs: string): Promise<void> {
  try {
    const text = await readFile(abs, 'utf8')
    const entry = watches.get(abs)
    if (entry) entry.lastText = text
    if (text !== lastSavedText || abs !== currentDocPath) {
      port.postMessage({ event: 'doc.changed', data: { path: abs, external: true, deleted: false } })
    }
  } catch {
    port.postMessage({ event: 'doc.changed', data: { path: abs, external: true, deleted: true } })
  }
}
/** 把 watch 重新指向新文件（文件被删除重建时 macOS fs.watch 句柄会失效） */
async function rewatch(abs: string): Promise<void> {
  const entry = watches.get(abs)
  if (!entry) return
  entry.watcher.close()
  watches.delete(abs)
  try {
    await watchDoc(abs)
  } catch {
    /* 文件暂时不存在，保持 unwatdocumented；recheck 会再试 */
  }
}

/* ---------------- 原子写 ---------------- */
async function atomicWrite(path: string, text: string): Promise<void> {
  const abs = isPluginManaged(path) ? normalize(path) : assertAccess(path)
  await ensureDir(dirname(abs))
  const tmp = `${abs}.${Date.now()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, abs)
}

/* ---------------- 图片资产 ---------------- */

/** 插件私有 assets 目录（默认图片落盘位置）：{dataLocalRoot}/assets */
function defaultAssetDir(): string {
  return join(dataLocalRoot(), 'assets')
}

/**
 * 把图片写进指定目录并返回可写进 Markdown 的链接。
 *
 * 目录来源有两类：
 *  - 前端经 `shell.resolvePath({ base: 'data' })` 解析出的绝对路径（用户手输的
 *    `~/图片`、`./assets` 等），必须显式登记授权后才允许写入；
 *  - 未配置时回落到插件私有 assets 目录（天然放行）。
 *
 * 返回 `{ url, dir }`：`dir` 是实际落盘目录（前端用它展示生效路径）。
 */
async function saveAssetBytes(docPath: string, fileName: string, bytes: Uint8Array, dir?: string): Promise<{ url: string; dir: string }> {
  const targetDir = dir ? normalize(dir) : defaultAssetDir()
  // 用户自定义目录：登记为持久授权（等价于用户在设置里明确指定了落盘位置）
  if (targetDir !== normalize(defaultAssetDir())) await grantPersistent(targetDir)
  else grant(targetDir)
  await ensureDir(targetDir)
  const finalPath = join(targetDir, fileName)
  if (!isPluginManaged(finalPath)) assertAccess(finalPath)
  await writeFile(finalPath, bytes)
  grant(finalPath)

  const abs = docPath ? normalize(docPath) : ''
  if (abs) {
    // 优先写相对文档的路径（移动整个文件夹后仍然有效）
    const rel = relative(dirname(abs), finalPath)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return { url: `./${rel.split(sep).join('/')}`, dir: targetDir }
  }
  return { url: finalPath.split(sep).join('/'), dir: targetDir }
}

/* ---------------- 上传器 ---------------- */
function extOf(mime: string, fileName: string): string {
  const fromName = extname(fileName)
  if (fromName) return fromName
  const map: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp' }
  return map[mime] ?? '.png'
}
function stampName(prefix: string, mime: string, fileName: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const cleanName = fileName ? basename(fileName, extname(fileName)).replace(/\.[^.]*$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '-') : 'image'
  const ext = extOf(mime, fileName)
  return `${date}-${time}-${cleanName}${ext}`
}

async function uploadLocal(docPath: string, fileName: string, mime: string, bytes: Uint8Array, dir?: string): Promise<{ url: string; markdown: string; dir: string }> {
  const saved = await saveAssetBytes(docPath, stampName('', mime, fileName), bytes, dir)
  return { url: saved.url, markdown: `![](${saved.url})`, dir: saved.dir }
}

async function uploadPiclist(server: string, fileName: string, mime: string, bytes: Uint8Array): Promise<{ url: string; markdown: string }> {
  const base = server.replace(/\/+$/, '')
  const form = new FormData()
  form.append('file', new Blob([bytes as unknown as Blob], { type: mime }), fileName)
  const res = await fetch(`${base}/upload`, { method: 'POST', body: form, headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`PicList HTTP ${res.status}`)
  const data: any = await res.json().catch(() => null)
  const url = data?.success ? (data.result ?? '') : (data?.result?.[0] ?? data?.url ?? '')
  if (!url) throw new Error(data?.message ? `PicList: ${data.message}` : 'PicList 响应中没有图片地址')
  return { url, markdown: `![](${url})` }
}

interface GithubRuntime { repo: string; branch: string; token: string; pathTemplate: string; cdn: string; commitMessage: string }
async function uploadGithub(cfg: GithubRuntime, fileName: string, mime: string, bytes: Uint8Array): Promise<{ url: string; markdown: string }> {
  if (!cfg.repo || !cfg.token) throw new Error('GitHub 图床未配置 repo 或 token')
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const rendered = (cfg.pathTemplate || 'images/{date}/{name}')
    .replaceAll('{date}', `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    .replaceAll('{name}', stampName('', mime, fileName))
  const branch = cfg.branch || 'main'
  const api = `https://api.github.com/repos/${cfg.repo}/contents/${encodeURI(rendered).replaceAll('%2F', '/')}?ref=${encodeURIComponent(branch)}`
  const content = Buffer.from(bytes).toString('base64')
  const put = await fetch(api, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: cfg.commitMessage || 'upload image', branch, content }),
  })
  if (!put.ok) {
    const errText = (await put.text()).slice(0, 200)
    throw new Error(`GitHub HTTP ${put.status}${put.status === 422 ? '（文件可能已存在）' : ''}${errText ? `: ${errText}` : ''}`)
  }
  const data: any = await put.json()
  let url: string = data?.content?.download_url ?? ''
  if (cfg.cdn) {
    url = cfg.cdn.replace(/\/+$/, '') + '/' + rendered
  }
  if (!url) throw new Error('GitHub 响应中没有 download_url')
  return { url, markdown: `![](${url})` }
}

/** 自定义脚本沙箱：无 require/process/fs；15s 超时 */
function buildScriptSandbox() {
  return {
    fetch,
    FormData,
    Blob,
    Buffer,
    crypto: {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      subtle: webcrypto.subtle,
      randomUUID: () => createHash('md5').update(String(Date.now()) + String(Math.random())).digest('hex').slice(0, 8) + '-' + Date.now().toString(16),
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
}
/**
 * 脚本 ctx.config.token 的取值策略：脚本是用户自写的任意上传逻辑（模板即 sm.ms），
 * 它约定的 token 语义就是「图床凭证」。凭证统一进 vault 后，脚本运行前由后端
 * 解引用注入（明文只存在于沙箱内存，不落盘不回传）；未配置时为空串。
 */
async function runUploadScript(code: string, ctxBase: { fileName: string; mime: string; bytes: Uint8Array }): Promise<{ url: string; markdown: string; logs: string[] }> {
  const sandbox = buildScriptSandbox()
  const context = vm.createContext({ ...sandbox, module: { exports: {} as any }, exports: {} as any })
  // CommonJS 契约：module.exports = async (ctx) => ...
  vm.runInContext(code, context, { timeout: 3000, filename: 'uploader.js' })
  const factory = (context as any).module.exports
  if (typeof factory !== 'function') throw new Error('脚本必须 module.exports = async (ctx) => ...')
  const logs2: string[] = []
  const cfg = await loadConfig()
  const token = await resolveSecret(cfg.uploaders.github.tokenRef)
  const ctx = {
    ...ctxBase,
    config: {
      token,
      piclist: cfg.uploaders.piclist,
      // github 子对象沿用「脱敏」约定，避免脚本把它打进日志
      github: { ...cfg.uploaders.github, token: token ? '(已配置)' : '' },
      raw: cfg.uploaders,
    },
    log: (msg: string) => { logs2.push(String(msg).slice(0, 500)); if (logs2.length > 50) logs2.shift() },
  }
  const result = await Promise.race([
    Promise.resolve(factory(ctx)),
    new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('脚本执行超时（15s）')), 15000); t.unref?.() }),
  ])
  const url = typeof result === 'string' ? result : result?.url
  if (!url || typeof url !== 'string') throw new Error('脚本未返回 url 字符串')
  const markdown = (typeof result === 'object' && result?.markdown) || `![](${url})`
  return { url, markdown: String(markdown), logs: logs2 }
}

/* ---------------- 目录树 ---------------- */
async function listTree(root: string, maxDepth = 6): Promise<unknown> {
  const abs = assertAccess(root)
  async function walk(dir: string, depth: number): Promise<unknown> {
    if (depth > maxDepth) return []
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes = []
    for (const entry of entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, 'zh') : a.isDirectory() ? -1 : 1))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        nodes.push({ type: 'dir', name: entry.name, path: full, children: await walk(full, depth + 1) })
      } else if (/\.(md|markdown)$/i.test(entry.name)) {
        let size = 0, mtime = 0
        try { const s = await stat(full); size = s.size; mtime = s.mtimeMs } catch { /* 忽略 */ }
        nodes.push({ type: 'file', name: entry.name, path: full, size, mtime })
      }
    }
    // 只含空目录时折叠掉
    return nodes.filter((n: any) => n.type === 'file' || (n.children && n.children.length))
  }
  return walk(abs, 0)
}

/* ---------------- 图片资产索引 ---------------- */
async function indexAssets(docPath: string, docText: string): Promise<unknown> {
  const abs = assertAccess(docPath)
  const refs: Array<{ raw: string; url: string; kind: 'remote' | 'local' | 'data' | 'missing'; file?: string; size?: number }> = []
  const seen = new Map<string, number>()
  const imgRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<img[^>]+src=["']([^"']+)["']/gi
  let m
  while ((m = imgRe.exec(docText))) {
    const url = (m[1] || m[2] || '').trim()
    if (!url || seen.has(url)) continue
    seen.set(url, 1)
    if (url.startsWith('data:')) { refs.push({ raw: m[0], url, kind: 'data' }); continue }
    if (/^https?:\/\//i.test(url)) { refs.push({ raw: m[0], url, kind: 'remote' }); continue }
    const localPath = resolve(dirname(abs), decodeURIComponent(url))
    try {
      const s = await stat(localPath)
      refs.push({ raw: m[0], url, kind: 'local', file: localPath, size: s.size })
    } catch {
      refs.push({ raw: m[0], url, kind: 'missing' })
    }
  }
  return { refs }
}

/* ---------------- 最近文件（KV：key 'recent'） ---------------- */
const RECENT_KEY = 'recent'
type RecentEntry = { path: string; name: string; at: number }
async function readRecent(): Promise<RecentEntry[]> {
  const stored = await storageGet(RECENT_KEY)
  return Array.isArray(stored) ? (stored as RecentEntry[]) : []
}
async function pushRecent(path: string): Promise<void> {
  const abs = normalize(path)
  const list = (await readRecent()).filter((n) => n.path !== abs)
  list.unshift({ path: abs, name: basename(abs), at: Date.now() })
  await storageSet(RECENT_KEY, list.slice(0, 30))
}

/* ---------------- 速记收件箱（KV：key 'inbox'） ---------------- */
const INBOX_KEY = 'inbox'
async function readInbox(): Promise<string> {
  const stored = await storageGet(INBOX_KEY)
  return typeof stored === 'string' ? stored : ''
}
async function appendInbox(text: string): Promise<void> {
  const prev = await readInbox()
  await storageSet(INBOX_KEY, prev ? `${prev}\n\n---\n\n${text}` : text)
}

/* ---------------- 用户主题（KV：'themes.index' + 'theme:{name}'） ---------------- */
const THEME_INDEX_KEY = 'themes.index'
const themeKey = (name: string) => `theme:${name}`
/** 主题名清洗：去掉路径分隔符，只留安全文件名语义字符 */
function cleanThemeName(name: unknown): string {
  return String(name).replace(/[/\\]/g, '')
}
async function themeIndex(): Promise<string[]> {
  const stored = await storageGet(THEME_INDEX_KEY)
  const list = Array.isArray(stored) ? stored.map(cleanThemeName).filter(Boolean) : []
  return [...new Set(list)]
}
async function writeThemeCss(name: string, css: string): Promise<void> {
  // 先写内容再写 index（非原子）：中断最多留下孤儿 key，不影响已列主题
  await storageSet(themeKey(name), css)
  const index = await themeIndex()
  if (!index.includes(name)) await storageSet(THEME_INDEX_KEY, [...index, name])
}
async function deleteThemeCss(name: string): Promise<void> {
  // KV 无删除能力：内容置空 + index 摘除（置空键占位可忽略）
  await storageSet(themeKey(name), '')
  await storageSet(THEME_INDEX_KEY, (await themeIndex()).filter((item) => item !== name))
}

/* ---------------- 旧数据迁移（~/.eNest/plugins/com.github.eNest.markdown） ---------------- */
/** 旧自管数据目录：仅迁移期读取（读旧数据 + 拷贝 assets），迁移完成后不再 touch */
function legacyRoot(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (!home) return ''
  return join(home, '.eNest', 'plugins', 'com.github.eNest.markdown')
}
async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}
interface LegacyData {
  config?: Record<string, unknown> | null
  recent?: unknown[] | null
  inbox?: string | null
  /** token 一次性明文返回（前端 vault.set 后即丢） */
  token?: string
  themes: Array<{ name: string; css: string }>
  assetsDir: string
}
/**
 * 导出旧目录数据（一次性）：config.json / recent.json / inbox 当日文件 / themes/*.css。
 * token 以明文随响应返回给前端，由前端 vault.set 落密钥库；本方法不再写任何文件。
 */
async function legacyExport(): Promise<LegacyData> {
  const root = legacyRoot()
  const empty: LegacyData = { config: null, recent: null, inbox: null, themes: [], assetsDir: root ? join(root, 'assets') : '' }
  if (!root || !(await pathExists(root))) return empty
  const readJsonFile = async <T>(p: string): Promise<T | null> => {
    try { return JSON.parse(await readFile(p, 'utf8')) as T } catch { return null }
  }
  const config = await readJsonFile<Record<string, unknown>>(join(root, 'config.json'))
  const recent = await readJsonFile<unknown[]>(join(root, 'recent.json'))
  // inbox 是按日期命名的多个文件（YYYY-MM-DD.md），全部合并导出（旧→新）
  const inboxTexts: string[] = []
  try {
    const inboxDir = join(root, 'inbox')
    const files = (await readdir(inboxDir)).filter((f) => /\.md$/i.test(f)).sort()
    for (const f of files) {
      try { inboxTexts.push(await readFile(join(inboxDir, f), 'utf8')) } catch { /* 单文件损坏跳过 */ }
    }
  } catch { /* 无 inbox 目录 */ }
  const themes: Array<{ name: string; css: string }> = []
  try {
    const themesDir = join(root, 'themes')
    const files = (await readdir(themesDir)).filter((f) => /\.css$/i.test(f)).sort()
    for (const f of files) {
      try {
        themes.push({ name: cleanThemeName(f.replace(/\.css$/i, '')), css: await readFile(join(themesDir, f), 'utf8') })
      } catch { /* 单文件损坏跳过 */ }
    }
  } catch { /* 无 themes 目录 */ }
  const token = typeof (config?.uploaders as any)?.github?.token === 'string' ? String((config?.uploaders as any).github.token) : ''
  return {
    config,
    recent: Array.isArray(recent) ? recent : null,
    inbox: inboxTexts.length ? inboxTexts.join('\n\n---\n\n') : null,
    token: token && token !== '(已配置)' ? token : '',
    themes,
    assetsDir: join(root, 'assets'),
  }
}

/* ---------------- 方法表 ---------------- */
const methods: Record<string, (args: unknown[]) => Promise<unknown>> = {
  /* —— 文档 —— */
  'doc.grant': async ([path]) => {
    grant(String(path))
    return { ok: true }
  },
  'doc.open': async ([path]) => {
    const abs = assertAccess(String(path))
    const text = await readFile(abs, 'utf8')
    await watchDoc(abs)
    await pushRecent(abs)
    return { path: abs, text }
  },
  'doc.save': async ([path, text]) => {
    const abs = String(path)
    suppressUntil = Date.now() + 400
    suppressPath = normalize(abs)
    await atomicWrite(abs, String(text))
    lastSavedText = String(text)
    const entry = watches.get(normalize(abs))
    if (entry) entry.lastText = String(text)
    // rename 原子写会使 macOS fs.watch 句柄失效，重建 watch
    void rewatch(normalize(abs))
    await pushRecent(abs)
    return { ok: true }
  },
  'doc.saveAs': async ([path, text]) => {
    // pickSave 选定的新路径：登记授权后原子写
    const abs = normalize(String(path))
    grant(abs)
    suppressUntil = Date.now() + 400
    suppressPath = abs
    await atomicWrite(abs, String(text))
    lastSavedText = String(text)
    await watchDoc(abs)
    await pushRecent(abs)
    return { path: abs }
  },
  'doc.watch': async ([path]) => {
    await watchDoc(String(path))
    return { ok: true }
  },
  'doc.unwatch': async ([path]) => {
    unwatchDoc(String(path))
    return { ok: true }
  },
  'doc.read': async ([path]) => {
    return { text: await readFile(assertAccess(String(path)), 'utf8') }
  },
  'doc.mtime': async ([path]) => {
    const s = await stat(assertAccess(String(path)))
    return { mtime: s.mtimeMs }
  },

  /* —— 目录 —— */
  'dir.grant': async ([path]) => {
    grant(String(path))
    const cfg = await loadConfig()
    if (!cfg.recentRoots.includes(String(path))) {
      cfg.recentRoots.unshift(String(path))
      cfg.recentRoots = cfg.recentRoots.slice(0, 8)
      await saveConfig(cfg)
    }
    return { ok: true }
  },
  'dir.list': async ([path]) => {
    return listTree(String(path))
  },
  'dir.recentRoots': async () => {
    const cfg = await loadConfig()
    return { roots: cfg.recentRoots }
  },

  /* —— 最近文件 —— */
  'recent.list': async () => {
    return { list: await readRecent() }
  },
  'recent.clear': async () => {
    await storageSet(RECENT_KEY, [])
    return { ok: true }
  },

  /* —— 速记 —— */
  'scratch.append': async ([text]) => {
    await appendInbox(String(text))
    return { ok: true }
  },
  'scratch.read': async () => {
    return { text: await readInbox() }
  },

  /* —— 图床 —— */
  'uploader.config': async () => {
    const cfg = await loadConfig()
    // token 不回明文：返回已配置/未配置布尔，前端据此时显示占位
    const configured = Boolean(cfg.uploaders.github.tokenRef)
    return {
      uploaders: {
        ...cfg.uploaders,
        github: { ...cfg.uploaders.github, tokenConfigured: configured },
        script: cfg.uploaders.script,
      },
    }
  },
  'uploader.saveConfig': async ([next]) => {
    const cfg = await loadConfig()
    const patch = (next ?? {}) as any
    if (patch.active !== undefined) cfg.uploaders.active = String(patch.active)
    if (patch.piclist?.server !== undefined) cfg.uploaders.piclist.server = String(patch.piclist.server)
    if (patch.github) {
      for (const key of ['repo', 'branch', 'tokenRef', 'pathTemplate', 'cdn', 'commitMessage'] as const) {
        if (patch.github[key] !== undefined) (cfg.uploaders.github as any)[key] = String(patch.github[key])
      }
    }
    if (typeof patch.script?.code === 'string') cfg.uploaders.script.code = patch.script.code
    await saveConfig(cfg)
    return { ok: true }
  },
  'uploader.test': async ([which]) => {
    // 1x1 PNG
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const cfg = await loadConfig()
    const name = stampName('', 'image/png', 'connectivity-test')
    if (which === 'piclist') return uploadPiclist(cfg.uploaders.piclist.server, name, 'image/png', png)
    if (which === 'github') return uploadGithub(await githubRuntimeConfig(), name, 'image/png', png)
    if (which === 'script') return runUploadScript(cfg.uploaders.script.code, { fileName: name, mime: 'image/png', bytes: png })
    throw new Error('未知图床: ' + which)
  },
  /**
   * 保存粘贴/拖入的图片。
   * `imageDir` 是前端用 `shell.resolvePath({ base: 'data' })` 解析出的绝对路径；
   * 空/缺省时落到插件私有 assets 目录。
   */
  'upload.run': async ([docPath, fileName, mime, bytesB64, imageDir]) => {
    const cfg = await loadConfig()
    const bytes = Buffer.from(String(bytesB64), 'base64')
    const name = stampName('', String(mime), String(fileName))
    const which = cfg.uploaders.active
    const dir = typeof imageDir === 'string' && imageDir.trim() ? imageDir.trim() : undefined
    if (which === 'local') {
      return uploadLocal(docPath ? String(docPath) : '', name, String(mime), bytes, dir)
    }
    if (which === 'piclist') return uploadPiclist(cfg.uploaders.piclist.server, name, String(mime), bytes)
    if (which === 'github') return uploadGithub(await githubRuntimeConfig(), name, String(mime), bytes)
    if (which === 'script') return runUploadScript(cfg.uploaders.script.code, { fileName: name, mime: String(mime), bytes })
    throw new Error('未知图床: ' + which)
  },
  /** 单独存本地图片（与图床选择无关；前端"存本地"动作直接走这里） */
  'upload.local': async ([docPath, fileName, mime, bytesB64, imageDir]) => {
    const bytes = Buffer.from(String(bytesB64), 'base64')
    const name = stampName('', String(mime), String(fileName))
    const dir = typeof imageDir === 'string' && imageDir.trim() ? imageDir.trim() : undefined
    return uploadLocal(docPath ? String(docPath) : '', name, String(mime), bytes, dir)
  },
  'script.compileCheck': async ([code]) => {
    const sandbox = buildScriptSandbox()
    const context = vm.createContext({ ...sandbox, module: { exports: {} as any }, exports: {} as any })
    vm.runInContext(String(code), context, { timeout: 3000, filename: 'uploader-check.js' })
    const factory = (context as any).module.exports
    if (typeof factory !== 'function') throw new Error('脚本必须 module.exports = async (ctx) => ...')
    return { ok: true }
  },

  /* —— 图片资产 —— */
  'assets.resolveRelative': async ([docPath, url]) => {
    const abs = assertAccess(String(docPath))
    const decoded = decodeURIComponent(String(url).split(/[?#]/)[0])
    return resolve(dirname(abs), decoded)
  },
  'assets.readDataUrl': async ([path]) => {
    let target: string
    const p = String(path)
    if (/^https?:\/\//i.test(p)) {
      // 远程图：下载后转 dataUrl（预览通道；缓存到临时目录避免重复下载）
      const cacheDir = join(dataLocalRoot(), 'cache')
      await ensureDir(cacheDir)
      const key = createHash('sha1').update(p).digest('hex')
      const cached = join(cacheDir, key)
      try {
        await stat(cached)
      } catch {
        const res = await fetch(p, { signal: AbortSignal.timeout(20000) })
        if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
        await writeFile(cached, new Uint8Array(await res.arrayBuffer()))
      }
      target = cached
    } else {
      target = assertAccess(p)
    }
    const buf = await readFile(target)
    const ext = extname(target).toLowerCase()
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' }
    let contentType = mime[ext] ?? 'application/octet-stream'
    if (contentType === 'application/octet-stream') {
      const sniff = buf.subarray(0, 12)
      if (sniff[0] === 0x89 && sniff[1] === 0x50) contentType = 'image/png'
      else if (sniff[0] === 0xff && sniff[1] === 0xd8) contentType = 'image/jpeg'
      else if (sniff[0] === 0x47 && sniff[1] === 0x49) contentType = 'image/gif'
      else if (sniff[8] === 0x57 && sniff[9] === 0x45) contentType = 'image/webp'
    }
    return { dataUrl: `data:${contentType};base64,${buf.toString('base64')}` }
  },
  'assets.index': async ([docPath, docText]) => {
    return indexAssets(String(docPath), String(docText ?? ''))
  },
  'assets.externalize': async ([docPath, url, imageDir]) => {
    // 外链转本地：下载到配置的图片目录（缺省为插件私有 assets），返回可写进源码的链接
    if (!/^https?:\/\//i.test(String(url))) throw new Error('仅支持 http(s) 外链')
    const res = await fetch(String(url), { signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    const mime = res.headers.get('content-type')?.split(';')[0] ?? 'image/png'
    const dir = typeof imageDir === 'string' && imageDir.trim() ? imageDir.trim() : undefined
    const saved = await saveAssetBytes(String(docPath), stampName('', mime, basename(new URL(String(url)).pathname) || 'image'), buf, dir)
    return { url: saved.url, dir: saved.dir }
  },
  'assets.remove': async ([path]) => {
    const abs = assertAccess(String(path))
    await rm(abs, { force: true })
    return { ok: true }
  },

  /* —— 主题 —— */
  'theme.list': async () => {
    const names = await themeIndex()
    return { themes: names.map((name) => ({ name })) }
  },
  'theme.read': async ([name]) => {
    const clean = cleanThemeName(name)
    const stored = await storageGet(themeKey(clean))
    return { css: typeof stored === 'string' ? stored : '' }
  },
  'theme.write': async ([name, css]) => {
    await writeThemeCss(cleanThemeName(name), String(css))
    return { ok: true }
  },
  'theme.delete': async ([name]) => {
    await deleteThemeCss(cleanThemeName(name))
    return { ok: true }
  },
  'theme.prefs': async () => {
    const cfg = await loadConfig()
    return { lightTheme: cfg.lightTheme, darkTheme: cfg.darkTheme }
  },
  'theme.setPrefs': async ([light, dark]) => {
    const cfg = await loadConfig()
    if (light !== undefined) cfg.lightTheme = String(light)
    if (dark !== undefined) cfg.darkTheme = String(dark)
    await saveConfig(cfg)
    return { ok: true }
  },

  /* —— 旧数据迁移 —— */
  /** 迁移状态探测：旧目录存在且未 migrated 时返回待迁移清单 */
  'legacy.inspect': async () => {
    const root = legacyRoot()
    const cfg = await loadConfig()
    if (!root) return { needed: false, done: cfg.migrated, legacyRoot: '' }
    const exists = await pathExists(root)
    return { needed: exists && !cfg.migrated, done: cfg.migrated, legacyRoot: root }
  },
  /** 一次性导出旧目录数据（含 token 明文）；只在迁移期调用 */
  'legacy.export': async () => {
    return legacyExport()
  },
  /**
   * 提交迁移：前端已 vault.set 存好 token，携带脱敏后的 config / recent / themes / inbox
   * 全量写入 KV，旧 assets 逐文件拷贝到新目录（不删原目录），置 migrated 标记。
   * KV set 幂等覆盖：中途失败下次启动重试不会损坏已写数据。
   */
  'legacy.commit': async ([payload]) => {
    const input = (payload ?? {}) as {
      config?: Record<string, unknown>
      recent?: unknown[]
      inbox?: string
      themes?: Array<{ name: string; css: string }>
    }
    const cfg = await loadConfig()
    // config：以旧值覆盖默认值（tokenRef 已由前端换好，旧 token 字段丢弃）
    if (input.config && typeof input.config === 'object') {
      const legacy = input.config as Partial<PluginConfig> & { uploaders?: Partial<UploaderConfig> & { github?: Record<string, unknown> } }
      if (Array.isArray(legacy.recentRoots)) cfg.recentRoots = legacy.recentRoots.slice(0, 8)
      if (typeof legacy.imageDir === 'string') cfg.imageDir = legacy.imageDir
      if (Array.isArray(legacy.imageDirs)) cfg.imageDirs = legacy.imageDirs.slice(0, 16)
      if (typeof legacy.lightTheme === 'string' && legacy.lightTheme) cfg.lightTheme = legacy.lightTheme
      if (typeof legacy.darkTheme === 'string' && legacy.darkTheme) cfg.darkTheme = legacy.darkTheme
      if (legacy.uploaders?.piclist && typeof legacy.uploaders.piclist.server === 'string') cfg.uploaders.piclist.server = legacy.uploaders.piclist.server
      if (legacy.uploaders?.github) {
        const gh = legacy.uploaders.github
        if (typeof gh.repo === 'string') cfg.uploaders.github.repo = gh.repo
        if (typeof gh.branch === 'string' && gh.branch) cfg.uploaders.github.branch = gh.branch
        if (typeof gh.pathTemplate === 'string' && gh.pathTemplate) cfg.uploaders.github.pathTemplate = gh.pathTemplate
        if (typeof gh.cdn === 'string') cfg.uploaders.github.cdn = gh.cdn
        if (typeof gh.commitMessage === 'string' && gh.commitMessage) cfg.uploaders.github.commitMessage = gh.commitMessage
        if (typeof gh.tokenRef === 'string') cfg.uploaders.github.tokenRef = gh.tokenRef
      }
      if (typeof legacy.uploaders?.script?.code === 'string' && legacy.uploaders.script.code) cfg.uploaders.script.code = legacy.uploaders.script.code
      if (typeof legacy.uploaders?.active === 'string' && legacy.uploaders.active) cfg.uploaders.active = legacy.uploaders.active
    }
    // recent / themes：旧值非空才覆盖（迁移重试时不回退已更新的 KV）
    if (Array.isArray(input.recent) && input.recent.length) await storageSet(RECENT_KEY, input.recent.slice(0, 30))
    // inbox：只在 KV 仍为空时导入旧文本（重试时已非空，避免重复追加）
    if (typeof input.inbox === 'string' && input.inbox && !(await readInbox())) {
      await storageSet(INBOX_KEY, input.inbox)
    }
    for (const theme of Array.isArray(input.themes) ? input.themes : []) {
      if (theme?.name && typeof theme.css === 'string') await writeThemeCss(cleanThemeName(theme.name), theme.css)
    }
    // 旧 assets 逐文件拷贝到新授权目录（保留原目录不删；旧 cache 不迁）
    const root = legacyRoot()
    if (root && await pathExists(join(root, 'assets'))) {
      const targetDir = join(dataLocalRoot(), 'assets')
      await ensureDir(targetDir)
      grant(targetDir)
      const files = (await readdir(join(root, 'assets'))).filter((f) => !f.startsWith('.'))
      for (const f of files) {
        try {
          const target = join(targetDir, f)
          if (!(await pathExists(target))) await copyFile(join(root, 'assets', f), target)
          grant(target)
        } catch { /* 单文件失败不阻塞迁移（下次重试跳过已存在文件） */ }
      }
    }
    cfg.migrated = true
    await saveConfig(cfg)
    return { ok: true }
  },
  /** 旧版清理（历史方法保留：只置标记，不再删除任何文件） */
  'legacy.cleanup': async () => {
    const cfg = await loadConfig()
    if (cfg.migrated) return { ok: true, skipped: true }
    cfg.migrated = true
    await saveConfig(cfg)
    return { ok: true, skipped: false }
  },

  /* —— 路径信息 —— */
  'info.paths': async () => {
    const cfg = await loadConfig()
    return {
      dataRoot: dataLocalRoot(),
      assetsDir: defaultAssetDir(),
      imageDir: cfg.imageDir || '',
    }
  },
  /** 设置页展示：登记手输目录（解析由前端 shell.resolvePath 完成）并回报落盘位置 */
  'images.setDir': async ([abs, raw]) => {
    if (typeof abs === 'string' && abs.trim()) await grantPersistent(abs.trim())
    const cfg = await loadConfig()
    cfg.imageDir = typeof raw === 'string' ? raw.trim() : ''
    await saveConfig(cfg)
    return { ok: true, assetsDir: defaultAssetDir(), imageDir: cfg.imageDir }
  },
}

port.on('message', ({ data: request }) => {
  // host.request 应答：匹配在途控制表
  if (request.type === 'host.response') {
    const pending = hostControls.get(Number(request.id))
    if (!pending) return
    hostControls.delete(Number(request.id))
    clearTimeout(pending.timer)
    if (request.ok === true) pending.resolve(request.data)
    else pending.reject(new Error(String(request.error || '宿主控制请求失败').slice(0, 4096)))
    return
  }
  if (request.type === 'init') {
    if (owner || typeof request.pluginId !== 'string') return
    // 仿 dsh runtimeContext：校验后冻结宿主上下文（appDataPath 是唯一授权数据目录）
    const ctx = request.context as { protocolVersion?: unknown; appDataPath?: unknown } | undefined
    const valid = request.pluginId === PLUGIN_ID
      && Number.isSafeInteger(request.generation) && Number(request.generation) >= 1
      && Number.isSafeInteger(request.wcId)
      && ctx?.protocolVersion === 1
      && typeof ctx.appDataPath === 'string' && isAbsolute(String(ctx.appDataPath))
    if (!valid) return
    owner = request.pluginId
    appDataPath = String(ctx.appDataPath)
    return
  }
  if (!Number.isSafeInteger(request.id)) return
  void (async () => {
    if (!owner || request.pluginId !== owner) throw new Error('Invalid backend owner')
    const handler = methods[request.method ?? '']
    if (!handler) throw new Error(`Unknown backend method: ${request.method}`)
    // 首次请求前回灌持久授权（图片目录重启后仍可读）
    await ensureGrantsLoaded()
    return handler(request.args ?? [])
  })().then(
    (data) => port.postMessage({ id: request.id, ok: true, data }),
    (error) => port.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  )
})
