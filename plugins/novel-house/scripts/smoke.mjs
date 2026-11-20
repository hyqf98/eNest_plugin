#!/usr/bin/env node
/**
 * novel-house 后端冒烟测试：绕过宿主 utilityProcess，直接以 require 方式加载
 * 编译前的规则引擎核心（从 backend/index.ts 抽取逻辑不可行——本脚本用 esbuild
 * 把 index.ts 编成 CJS 后 mock parentPort 跑全链路）。
 *
 * 用法：node scripts/smoke.mjs [--no-net]
 * （仅本地开发验证用，不进发布包）
 */
import { build } from 'esbuild'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const backendDir = join(here, '..', 'backend')
const sourcesDir = join(here, '..', 'sources')
// node:require 从 tmp 目录解析不到 undici —— 以插件仓根为基准解析依赖
const require = createRequire(join(here, '..', '..', '..', 'package.json'))

const tmp = await mkdtemp(join(tmpdir(), 'nh-smoke-'))
const outfile = join(tmp, 'backend.cjs')
const undiciPath = require.resolve('undici', { paths: [join(here, '..')] })
await build({
  entryPoints: [join(backendDir, 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  alias: { undici: undiciPath.replace(/\/index\.js$/, '') },
  logLevel: 'warning',
})
// bundle:alias 已把 undici 打进产物；直接加载会因 parentPort 缺失 throw，
// 后续用 iife + banner shim 的二次构建来跑（见下），此处不再加载。
void outfile

/* ---- mock parentPort + storage ---- */
const storage = new Map()
let seq = 0
const pendingCalls = new Map()
const events = []
process.exitCode = 0

// 由于 parentPort 检查在模块加载时执行，本脚本采用另一种方式：
// 编译成 IIFE 并在前面注入 mock。见下方二次构建。
console.log('[smoke] rebuilding with port shim…')
await build({
  entryPoints: [join(backendDir, 'index.ts')],
  outfile: join(tmp, 'backend2.cjs'),
  bundle: true,
  platform: 'node',
  format: 'iife',
  target: 'node22',
  alias: { undici: undiciPath.replace(/\/index\.js$/, '') },
  banner: {
    js: `
globalThis.__nh_port = {
  handlers: [],
  on(event, fn) { if (event === 'message') this.handlers.push(fn) },
  postMessage(msg) {
    globalThis.__nh_sent.push(msg)
    // host.response 必须同步递送回 backend 处理器（否则后端控制请求 30s 超时）
    if (msg && msg.type === 'host.response') {
      for (const fn of this.handlers) fn({ data: msg })
    }
  },
};
globalThis.__nh_sent = [];
Object.defineProperty(process, 'parentPort', { value: globalThis.__nh_port, configurable: true });
`,
  },
  footer: {
    js: `
globalThis.__nh_call = (id, method, args) => { globalThis.__nh_port.handlers.forEach(fn => fn({ data: { id, pluginId: 'smoke', method, args } })) };
`,
  },
})

// footer 把 __nh_call 挂到 globalThis；先加载执行（顶层完成 init 注册），再取句柄
require(join(tmp, 'backend2.cjs'))
const __nh_call = globalThis.__nh_call
if (!__nh_call) throw new Error('backend shim did not expose __nh_call')

function call(method, args = []) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pendingCalls.set(id, { resolve, reject })
    __nh_call(id, method, args)
    drain()   // 同步起步：backend 同步 postMessage 的链路立即处理
  })
}
// promise 泵：轮询收割 __nh_sent，resolve 对应 pending 调用；结束时置 done 停泵
let pumpDone = false
async function pump() {
  while (!pumpDone) {
    await new Promise(r => setTimeout(r, 15))
    drain()
  }
}
function drain() {
  const sent = [...globalThis.__nh_sent]
  globalThis.__nh_sent.length = 0
  for (const msg of sent) {
    if (msg.type === 'host.request') {
      // mock 宿主 storage
      const { method, params, id } = msg
      if (method === 'storage.get') {
        globalThis.__nh_port.postMessage({ type: 'host.response', id, ok: true, data: storage.get(params.key) ?? null })
      } else if (method === 'storage.set') {
        storage.set(params.key, params.value)
        globalThis.__nh_port.postMessage({ type: 'host.response', id, ok: true, data: { ok: true } })
      } else if (method === 'storage.list') {
        const out = []
        for (const [k, v] of storage) if (k.startsWith(params.prefix ?? '')) out.push({ key: k, value: v })
        globalThis.__nh_port.postMessage({ type: 'host.response', id, ok: true, data: out })
      } else {
        globalThis.__nh_port.postMessage({ type: 'host.response', id, ok: false, error: `unsupported ${method}` })
      }
      // host.response 递归收割（storage.set 里可能再触发 host.request 链）
      drain()
    } else if (msg.type === 'host.response' || msg.type === 'shutdown.complete') {
      /* 已由 banner shim 同步递送回 backend，这里跳过（防 id 撞号误 resolve smoke 调用） */
    } else if (msg.event) {
      events.push(msg)
    } else if (msg.id !== undefined) {
      const p = pendingCalls.get(msg.id)
      if (p) {
        pendingCalls.delete(msg.id)
        msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error))
      }
    }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const NO_NET = process.argv.includes('--no-net')
let failures = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

/* ---- init ---- */
globalThis.__nh_port.handlers.forEach(fn => fn({ data: { type: 'init', pluginId: 'smoke', context: { protocolVersion: 1, packagePath: join(here, '..'), appDataPath: tmp } } }))
const pumpHandle = pump()   // 保持事件循环活着（永不 resolve）
void pumpHandle
await sleep(120)

/* ---- 1. sources.list 首启自动安装 ---- */
const list = await call('sources.list')
check('sources.list 内置自动安装', Array.isArray(list) && list.length >= 1, `${list.length} 个源`)
if (list.length < 1) {
  console.log('\n[smoke] ABORT: builtin sources not installed (builtin dir missing?)')
  pumpDone = true
  process.exit(1)
}
check('源已启用', list.every(s => s.enabled !== false))

/* ---- 2. 探索 ---- */
if (!NO_NET) {
  const b5200 = list.find(s => s.key.includes('b5200.org')) ?? list[0]
  const titles = await call('explore.titles', [b5200.key])
  check('explore.titles', titles.length >= 6, titles.map(t => t.title).slice(0, 4).join('、'))

  const ex = await call('explore.load', [b5200.key, titles[0].title, 1])
  check('explore.load 返回书卡', ex.books.length >= 10, `${ex.books.length} 本，首：${ex.books[0]?.title} / ${ex.books[0]?.author}`)

  /* ---- 3. 搜索（中文关键词，覆盖 GBK GET 编码链路） ---- */
  const search = await call('search.load', [b5200.key, '圣墟', 1])
  check('search.load 搜索「圣墟」', search.books.length >= 1, `${search.books.length} 结果，首：${search.books[0]?.title}（${search.books[0]?.author}）→ ${search.books[0]?.id?.slice(0, 50)}`)


  /* ---- 3.5 封面三级回退（列表无 coverUrl 的书卡） ---- */
  {
    const nb = search.books.find(b => !b.cover) ?? search.books[0]
    const coverFallback = await call('cover.load', [b5200.key, '', nb.id])
    check('cover.load 封面回退', coverFallback.base64?.length > 1000, `无 coverUrl 书卡补图 bytes≈${Math.round(coverFallback.base64.length * 3 / 4 / 1024)}KB mime=${coverFallback.mime}`)
  }

  /* ---- 4. 详情 ---- */
  const info = await call('book.info', [b5200.key, search.books[0].id])
  check('book.info 详情', !!info.title, `${info.title} / ${info.author} / 最新:${(info.lastChapter || '').slice(0, 20)}`)
  check('book.info 封面', !!info.cover, info.cover.slice(0, 60))

  /* ---- 5. 目录 ---- */
  const toc = await call('book.toc', [b5200.key, search.books[0].id, info.tocUrl])
  check('book.toc 目录', toc.chapters.length >= 100, `${toc.chapters.length} 章，首：${toc.chapters[0]?.title}，末：${toc.chapters.at(-1)?.title}`)

  /* ---- 6. 正文 ---- */
  const content = await call('book.content', [b5200.key, search.books[0].id, toc.chapters[0].id, toc.chapters[0].title])
  check('book.content 正文', content.paragraphs.length >= 5, `${content.paragraphs.length} 段，首段：${content.paragraphs[0]?.slice(0, 30)}`)

  /* ---- 7. 封面代理 ---- */
  if (info.cover) {
    const cover = await call('cover.load', [b5200.key, info.cover])
    check('cover.load 封面代理', cover.base64?.length > 1000, `mime=${cover.mime} bytes≈${Math.round(cover.base64.length * 3 / 4 / 1024)}KB`)
  }

  /* ---- 8. 缓存一章 ---- */
  const cached = await call('cache.chapter', [b5200.key, search.books[0].id, toc.chapters[0].id, toc.chapters[0].title])
  check('cache.chapter 离线一章', cached.paragraphs >= 5)
  const status = await call('cache.status', [b5200.key, search.books[0].id])
  check('cache.status 命中', status.cached && status.chapters.includes(toc.chapters[0].id))
  const content2 = await call('book.content', [b5200.key, search.books[0].id, toc.chapters[0].id, toc.chapters[0].title])
  check('离线正文读回', content2.cached === true && content2.paragraphs.length === content.paragraphs.length)
}


  /* ---- 8.5 聚合方法 ---- */
  if (!NO_NET) {
    const homeAgg = await call('home.aggregate', [])
    check('home.aggregate 聚合首页', Array.isArray(homeAgg) && homeAgg.length >= 1, `${homeAgg.length} 源分区，sections 总数 ${homeAgg.reduce((s, x) => s + (x.sections?.length ?? 0), 0)}`)

    const filters = await call('filters.aggregate', [])
    check('filters.aggregate 筛选维度', filters.length >= 1 && filters.some(f => f.categories.length > 0), `${filters.length} 源，分类数 ${filters.map(f => f.categories.length).join('/')}`)

    const firstCat = filters.find(f => f.categories.length > 0)
    const fl = await call('filters.load', [firstCat.sourceKey, 'category', firstCat.categories[0].param, 1])
    check('filters.load 分类加载', fl.books.length >= 10, `${firstCat.categories[0].label} → ${fl.books.length} 本`)

    const expAgg = await call('explore.aggregate', [1])
    check('explore.aggregate 聚合分类', expAgg.length >= 1 && expAgg.some(x => x.books.length > 0), expAgg.map(x => `${x.sourceName}:${x.books.length}`).join(' '))

    // 流式聚合搜索：等 finished 事件
    const aggStart = await call('search.aggregate', ['圣墟', 1])
    check('search.aggregate 启动', !!aggStart.streamId && aggStart.total >= 1, `stream=${aggStart.streamId?.slice(0, 24)}… total=${aggStart.total}`)
    const aggGroups = await new Promise(resolve => {
      const groups = []
      let settled = 0
      const t0 = Date.now()
      const poll = setInterval(() => {
        drain()
        for (const ev of events) {
          if (ev.event !== 'search.aggregate' || ev.data.streamId !== aggStart.streamId) continue
          if (ev.data.finished) { clearInterval(poll); resolve(groups); return }
          if (ev.data.sourceKey && !groups.some(g => g.sourceKey === ev.data.sourceKey)) {
            groups.push({ sourceKey: ev.data.sourceKey, sourceName: ev.data.sourceName, books: ev.data.books ?? [], error: ev.data.error })
          }
        }
        settled = groups.length
        if (Date.now() - t0 > 90_000) { clearInterval(poll); resolve(groups) }
      }, 200)
    })
    check('search.aggregate 流式结果', aggGroups.length >= 1, aggGroups.map(g => `${g.sourceName}:${g.books.length}${g.error ? '(!)' : ''}`).join(' '))
  }

/* ---- 9. 代理配置 ---- */
const proxy = await call('net.getProxy')
check('net.getProxy', typeof proxy.mode === 'string', `mode=${proxy.mode}`)

/* ---- 10. 源启停/删除（不动内置：启用→停用→启用） ---- */
await call('sources.setEnabled', [list[0].key, false])
const list2 = await call('sources.list')
check('sources.setEnabled 停用', list2.find(s => s.key === list[0].key)?.enabled === false)
await call('sources.setEnabled', [list[0].key, true])

/* ---- 11. 文本导入（数组批量 + 重复安装幂等） ---- */
const rawSource = await readFile(join(sourcesDir, 'b5200.json'), 'utf-8')
const arr = JSON.stringify([JSON.parse(rawSource)])
const imported = await call('sources.installFromText', [arr])
check('installFromText 数组批量', imported.installed >= 1)

console.log(`\n[smoke] ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (storage keys: ${storage.size})`)
pumpDone = true
await sleep(30)
await rm(tmp, { recursive: true, force: true })
process.exit(failures ? 1 : 0)