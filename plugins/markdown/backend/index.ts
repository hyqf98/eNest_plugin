/**
 * markdown v2 后端 —— utilityProcess 入口。
 * 职责：本地 .md 持续读写（原子写 + watch）、目录树、最近文件、速记收件箱、
 * 图床（本地 assets / PicList / GitHub / 自定义 JS 沙箱）、主题 CSS 目录、图片资产索引。
 * 零 npm 依赖：全部 Node 内置 + Node 22 原生 fetch/FormData。
 *
 * 安全约定：
 *  - 路径越界一律拒绝：文件只允许打开用户经选择器/拖拽授权过的路径或其所在工作根内；
 *  - 自定义上传脚本在 node:vm 中执行，无 require/process/fs，15s 超时；
 *  - 凭证与脚本明文存插件私有数据目录（用户 profile 内），不进错误消息。
 */
import { createHash, webcrypto } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { watch } from 'node:fs'
import { readFile, writeFile, mkdir, readdir, stat, rename, rm, copyFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, basename, extname, isAbsolute } from 'node:path'
import vm from 'node:vm'

type Request = {
  type?: string
  id?: number
  pluginId?: string
  method?: string
  args?: unknown[]
}
interface ParentPort {
  on(event: 'message', listener: (message: { data: Request }) => void): void
  postMessage(message: unknown): void
}
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!port) throw new Error('This entry requires the eNest utility process')
let owner: string | undefined

/* ---------------- 数据根 ---------------- */
/** 插件私有数据目录：~/.eNest/plugins/com.github.eNest.markdown/（与宿主数据根同盘） */
function dataRoot(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (!home) throw new Error('No user home directory')
  return join(home, '.eNest', 'plugins', 'com.github.eNest.markdown')
}
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}
async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path))
  const tmp = `${path}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, path)
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
/** 授权检查：路径等于已授权项，或位于已授权目录之内 */
function assertAccess(p: string): string {
  const abs = normalize(p)
  for (const g of grantedPaths) {
    if (abs === g) return abs
    const rel = relative(g, abs)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return abs
  }
  throw new Error('路径未授权：请先通过文件选择器或拖拽打开')
}
/** 收件箱/主题等插件自管路径天然放行 */
function isPluginManaged(p: string): boolean {
  const abs = normalize(p)
  const root = dataRoot()
  return abs === root || abs.startsWith(root + '/')
}

/* ---------------- 配置 ---------------- */
interface UploaderConfig {
  active: string
  piclist: { server: string }
  github: { repo: string; branch: string; token: string; pathTemplate: string; cdn: string; commitMessage: string }
  script: { code: string }
}
interface PluginConfig {
  uploaders: UploaderConfig
  lightTheme: string
  darkTheme: string
  recentRoots: string[]
  migrated: boolean
}
const defaultConfig = (): PluginConfig => ({
  uploaders: {
    active: 'local',
    piclist: { server: 'http://127.0.0.1:36677' },
    github: { repo: '', branch: 'main', token: '', pathTemplate: 'images/{date}/{name}', cdn: '', commitMessage: 'upload by eNest markdown' },
    script: { code: SCRIPT_TEMPLATE },
  },
  lightTheme: 'enest-minimal',
  darkTheme: 'enest-minimal-dark',
  recentRoots: [],
  migrated: false,
})
const SCRIPT_TEMPLATE = `// 自定义图床脚本：module.exports = async (ctx) => url 或 { url, markdown }
// ctx = { fileName, mime, bytes(Uint8Array), config, log }；可用全局：fetch/FormData/Blob/Buffer/crypto/URL/TextEncoder
// 返回字符串 url，或 { url, markdown }（markdown 缺省为 "![](url)"）
module.exports = async (ctx) => {
  const form = new FormData()
  form.append('smfile', new Blob([ctx.bytes], { type: ctx.mime }), ctx.fileName)
  const res = await fetch('https://smms.app/api/v2/upload', { method: 'POST', headers: { Authorization: \`Basic \${ctx.config.token}\` }, body: form })
  const data = await res.json()
  ctx.log('sm.ms response: ' + data.code)
  return data.data.url
}
`
async function configPath(): Promise<string> {
  return join(dataRoot(), 'config.json')
}
async function loadConfig(): Promise<PluginConfig> {
  const stored = await readJson<Partial<PluginConfig>>(await configPath(), {})
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
  await writeJson(await configPath(), next)
}

/* ---------------- 文档 watch ---------------- */
interface WatchEntry {
  path: string
  watcher: ReturnType<typeof watch>
  lastText: string
}
const watches = new Map<string, WatchEntry>()
const bus = new EventEmitter()
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
async function saveAssetBytes(docPath: string, fileName: string, bytes: Uint8Array): Promise<string> {
  const abs = assertAccess(docPath)
  const base = basename(abs, extname(abs))
  const assetDir = join(dirname(abs), `${base}.assets`)
  await ensureDir(assetDir)
  const target = join(assetDir, fileName)
  const finalPath = isPluginManaged(target) ? target : assertAccess(target)
  await writeFile(finalPath, bytes)
  grant(dirname(finalPath))
  return `${assetDir}/${fileName}`
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

async function uploadLocal(docPath: string, fileName: string, mime: string, bytes: Uint8Array): Promise<{ url: string; markdown: string }> {
  const saved = await saveAssetBytes(docPath, stampName('', mime, fileName), bytes)
  const relUrl = `./${basename(dirname(saved))}/${basename(saved)}`
  return { url: relUrl, markdown: `![](${relUrl})` }
}

async function uploadPiclist(server: string, fileName: string, mime: string, bytes: Uint8Array): Promise<{ url: string; markdown: string }> {
  const base = server.replace(/\/+$/, '')
  const form = new FormData()
  form.append('file', new Blob([bytes as unknown as BlobPart], { type: mime }), fileName)
  const res = await fetch(`${base}/upload`, { method: 'POST', body: form, headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`PicList HTTP ${res.status}`)
  const data: any = await res.json().catch(() => null)
  const url = data?.success ? (data.result ?? '') : (data?.result?.[0] ?? data?.url ?? '')
  if (!url) throw new Error(data?.message ? `PicList: ${data.message}` : 'PicList 响应中没有图片地址')
  return { url, markdown: `![](${url})` }
}

async function uploadGithub(cfg: UploaderConfig['github'], fileName: string, mime: string, bytes: Uint8Array): Promise<{ url: string; markdown: string }> {
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
async function runUploadScript(code: string, ctxBase: { fileName: string; mime: string; bytes: Uint8Array }, config: UploaderConfig): Promise<{ url: string; markdown: string; logs: string[] }> {
  const logs: string[] = []
  const sandbox = buildScriptSandbox()
  const context = vm.createContext({ ...sandbox, module: { exports: {} as any }, exports: {} as any })
  // CommonJS 契约：module.exports = async (ctx) => ...
  vm.runInContext(code, context, { timeout: 3000, filename: 'uploader.js' })
  const factory = (context as any).module.exports
  if (typeof factory !== 'function') throw new Error('脚本必须 module.exports = async (ctx) => ...')
  const logs2: string[] = []
  const ctx = {
    ...ctxBase,
    config: { piclist: config.uploaders.piclist, github: { ...config.uploaders.github, token: config.uploaders.github.token ? '(已配置)' : '' }, raw: config },
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

/* ---------------- 最近文件 ---------------- */
async function recentPath(): Promise<string> {
  return join(dataRoot(), 'recent.json')
}
async function pushRecent(path: string): Promise<void> {
  const abs = normalize(path)
  const list = (await readJson<Array<{ path: string; name: string; at: number }>>(await recentPath(), [])).filter((n) => n.path !== abs)
  list.unshift({ path: abs, name: basename(abs), at: Date.now() })
  await writeJson(await recentPath(), list.slice(0, 30))
}

/* ---------------- 速记收件箱 ---------------- */
async function inboxFile(): Promise<string> {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const dir = join(dataRoot(), 'inbox')
  await ensureDir(dir)
  return join(dir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`)
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
    return { list: await readJson(await recentPath(), []) }
  },
  'recent.clear': async () => {
    await writeJson(await recentPath(), [])
    return { ok: true }
  },

  /* —— 速记 —— */
  'scratch.append': async ([text]) => {
    const file = await inboxFile()
    grant(file)
    let prev = ''
    try { prev = await readFile(file, 'utf8') } catch { /* 当日首条 */ }
    const next = prev ? `${prev}\n\n---\n\n${String(text)}` : String(text)
    await atomicWrite(file, next)
    return { path: file }
  },
  'scratch.read': async () => {
    const file = await inboxFile()
    try { return { path: file, text: await readFile(file, 'utf8') } } catch { return { path: file, text: '' } }
  },

  /* —— 图床 —— */
  'uploader.config': async () => {
    const cfg = await loadConfig()
    // token 脱敏返回（前端编辑时显示掩码，保存时留空即保留原值）
    return {
      uploaders: {
        ...cfg.uploaders,
        github: { ...cfg.uploaders.github, token: cfg.uploaders.github.token ? '(已配置)' : '' },
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
      for (const key of ['repo', 'branch', 'pathTemplate', 'cdn', 'commitMessage'] as const) {
        if (patch.github[key] !== undefined) (cfg.uploaders.github as any)[key] = String(patch.github[key])
      }
      if (typeof patch.github.token === 'string' && patch.github.token && patch.github.token !== '(已配置)') cfg.uploaders.github.token = patch.github.token
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
    if (which === 'github') return uploadGithub(cfg.uploaders.github, name, 'image/png', png)
    if (which === 'script') return runUploadScript(cfg.uploaders.script.code, { fileName: name, mime: 'image/png', bytes: png }, cfg)
    throw new Error('未知图床: ' + which)
  },
  'upload.run': async ([docPath, fileName, mime, bytesB64]) => {
    const cfg = await loadConfig()
    const bytes = Buffer.from(String(bytesB64), 'base64')
    const name = stampName('', String(mime), String(fileName))
    const which = cfg.uploaders.active
    if (which === 'local') {
      if (!docPath) throw new Error('本地 assets 模式需要先保存文档')
      return uploadLocal(String(docPath), name, String(mime), bytes)
    }
    if (which === 'piclist') return uploadPiclist(cfg.uploaders.piclist.server, name, String(mime), bytes)
    if (which === 'github') return uploadGithub(cfg.uploaders.github, name, String(mime), bytes)
    if (which === 'script') return runUploadScript(cfg.uploaders.script.code, { fileName: name, mime: String(mime), bytes }, cfg)
    throw new Error('未知图床: ' + which)
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
      const cacheDir = join(dataRoot(), 'cache')
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
  'assets.externalize': async ([docPath, url]) => {
    // 外链转本地：下载到 assets 目录，返回相对链接
    if (!/^https?:\/\//i.test(String(url))) throw new Error('仅支持 http(s) 外链')
    const res = await fetch(String(url), { signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    const mime = res.headers.get('content-type')?.split(';')[0] ?? 'image/png'
    const saved = await saveAssetBytes(String(docPath), stampName('', mime, basename(new URL(String(url)).pathname) || 'image'), buf)
    const relUrl = `./${basename(dirname(saved))}/${basename(saved)}`
    return { url: relUrl }
  },
  'assets.remove': async ([path]) => {
    const abs = assertAccess(String(path))
    await rm(abs, { force: true })
    return { ok: true }
  },

  /* —— 主题 —— */
  'theme.list': async () => {
    const dir = join(dataRoot(), 'themes')
    await ensureDir(dir)
    const entries = await readdir(dir, { withFileTypes: true })
    return { themes: entries.filter((e) => e.isFile() && /\.css$/i.test(e.name)).map((e) => ({ name: e.name.replace(/\.css$/i, ''), file: join(dir, e.name) })) }
  },
  'theme.read': async ([name]) => {
    const clean = String(name).replace(/[/\\]/g, '')
    const file = join(dataRoot(), 'themes', `${clean}.css`)
    if (!isPluginManaged(file)) throw new Error('非法主题名')
    try { return { css: await readFile(file, 'utf8') } } catch { return { css: '' } }
  },
  'theme.write': async ([name, css]) => {
    const clean = String(name).replace(/[/\\]/g, '')
    const file = join(dataRoot(), 'themes', `${clean}.css`)
    if (!isPluginManaged(file)) throw new Error('非法主题名')
    await ensureDir(dirname(file))
    await atomicWrite(file, String(css))
    return { ok: true }
  },
  'theme.delete': async ([name]) => {
    const clean = String(name).replace(/[/\\]/g, '')
    const file = join(dataRoot(), 'themes', `${clean}.css`)
    if (!isPluginManaged(file)) throw new Error('非法主题名')
    await rm(file, { force: true })
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

  /* —— 旧版清理 —— */
  'legacy.cleanup': async () => {
    const cfg = await loadConfig()
    if (cfg.migrated) return { ok: true, skipped: true }
    cfg.migrated = true
    await saveConfig(cfg)
    return { ok: true, skipped: false }
  },

  /* —— 路径信息 —— */
  'info.paths': async () => {
    return { dataRoot: dataRoot(), themesDir: join(dataRoot(), 'themes'), inboxDir: join(dataRoot(), 'inbox') }
  },
}

port.on('message', ({ data: request }) => {
  if (request.type === 'init') {
    if (!owner && typeof request.pluginId === 'string') owner = request.pluginId
    return
  }
  if (!Number.isSafeInteger(request.id)) return
  void (async () => {
    if (!owner || request.pluginId !== owner) throw new Error('Invalid backend owner')
    const handler = methods[request.method ?? '']
    if (!handler) throw new Error(`Unknown backend method: ${request.method}`)
    return handler(request.args ?? [])
  })().then(
    (data) => port.postMessage({ id: request.id, ok: true, data }),
    (error) => port.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  )
})
