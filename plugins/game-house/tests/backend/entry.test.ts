/**
 * 后端入口端到端：用假的 parentPort 像宿主一样驱动真实的 backend/index.ts。
 * 这里的每个请求都走完整的消息循环（init → host.request 往返 → dispatch → 响应 / 事件），
 * 所以能发现"类型对但接错了"的问题：宿主方法名写错、消息形状不对、初始化顺序问题。
 * 网络用假响应，不联网。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import test from 'node:test'
import { createMockAdapter } from '../../backend/adapters/mock.ts'
import { setAdapter } from '../../backend/adapters/current.ts'
import { installHostStub } from './host-stub.ts'
import { flushStore, saveAuthMeta, saveItems, saveTasks } from '../../backend/store.ts'
import type { Task } from '../../src/shared/contracts.ts'

const ODE = 'https://www.uy5.net/wodown/resources/'
const COVER = 'https://www.uy5.net/wp-content/uploads/cover.png'
const DOWNLOAD = 'https://cdn.example.com/xinglu.zip'
const FILE_SIZE = 2 * 1024 * 1024 + 777
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

type Reply = { ok: boolean; data?: unknown; error?: string }

interface App {
  call(method: string, args?: unknown[]): Promise<Reply>
  stub: ReturnType<typeof installHostStub>
  root: string
  events: Array<{ event: string; data: unknown }>
  close(): Promise<void>
}

/** 凯撒 +3 的逆变换：把 ode 请求体里的参数串还原出来 */
function caesar3Inv(text: string): string {
  return text.replace(/[a-zA-Z]/g, c => { const base = c.charCodeAt(0) <= 90 ? 65 : 97; return String.fromCharCode(((c.charCodeAt(0) - base + 23) % 26) + base) })
}

/** 装好假宿主端口 + 假网络，发 init，返回调用与事件收集器 */
async function boot(): Promise<App> {
  const stub = installHostStub()
  const mock = await createMockAdapter()
  setAdapter(mock.adapter)
  saveItems([]); saveTasks([])
  saveAuthMeta({ sessionRef: '', accountRef: '', passwordRef: '', nickname: '', account: '', loginAt: 0 })
  await flushStore()
  stub.handles.set('dir-download', mock.root)
  stub.handles.set('dir-install', mock.root)
  stub.confirmAnswer = true

  const listBody = JSON.stringify({
    list: [
      { id: '1001', post_title: '星露奇缘', Subtitle: '农场模拟', thumbnail_img: COVER, categories: '模拟经营', appIco: 'https://www.uy5.net/ico.png' },
      { id: '1002', post_title: '没有封面的游戏', Subtitle: '', thumbnail_img: '', appIco: '' },
    ],
    Numberofarticlescount: '2', pageSize: '24',
  })
  const detailBody = JSON.stringify({
    id: '1001', post_title: '星露奇缘', Subtitle: '农场模拟', thumbnail_img: COVER,
    GameIntroduction: '<p>介绍<script>alert(1)</script><img src="https://www.uy5.net/a.jpg"><a href="javascript:evil()">x</a></p>',
    carousel: [], datetime: '2026-11-01', filesize_z: '1.5 GB', MinimumConfiguration: '', recommendConfiguration: '', offcialUrl: '',
  })
  const filesBody = JSON.stringify({
    list: [
      { coID: DOWNLOAD, coName: '星露奇缘.zip', coSize: '1.5 GB', type: 'file', openPath: 'Stardew/Stardew.exe', udTime: '2026-11-01' },
      { coID: 'folder-9', coName: '附加内容', coSize: '', type: 'folder', openPath: '', udTime: '' },
    ],
  })
  // ode 站点接口：请求体 {"EData": 凯撒+3(参数串)}，按参数串里的 action 路由到假响应
  const originalRequest = mock.adapter.request.bind(mock.adapter)
  mock.adapter.request = async options => {
    if (options.url !== ODE || options.method !== 'POST') return originalRequest(options)
    const raw = typeof options.body === 'string' ? options.body : new TextDecoder().decode(options.body as Uint8Array)
    const params = caesar3Inv((JSON.parse(raw) as { EData: string }).EData)
    const body = params.startsWith('action=getAppList') ? listBody : params.startsWith('action=getPostArticle') ? detailBody : params.startsWith('action=getAppDownList') ? filesBody : '{}'
    return { status: 200, headers: { 'content-type': 'application/json' }, setCookies: [], location: '', body: new TextEncoder().encode(body) }
  }
  mock.network.respond(COVER, { status: 200, headers: { 'content-type': 'image/png' }, body: PNG })
  mock.network.stream(DOWNLOAD, { size: FILE_SIZE, acceptRanges: true, etag: '"e1"' })
  mock.archives.register('xinglu.zip', { outputs: [{ name: 'Stardew/Stardew.exe', size: 4096 }, { name: 'Stardew/data.pak', size: 1024 }] })

  const events: Array<{ event: string; data: unknown }> = []
  const pending = new Map<number, { resolve: (value: Reply) => void }>()
  // index.ts 在模块加载时就向 parentPort 注册监听，而模块只会加载一次；
  // 所以端口必须是进程级单例，各用例复用它、只重置状态。
  const port = sharedPort()
  port.handlers = {
    onHostRequest: message => { stub.postMessage(message) },
    onEvent: (event, data) => { events.push({ event, data }) },
    onReply: (id, ok, data, error) => { pending.get(id)?.resolve({ ok, data, error }); pending.delete(id) },
  }
  // 必须在加载入口之前装好：入口在模块加载时就调用 parentPort() 并注册监听
  ;(process as unknown as { parentPort: unknown }).parentPort = port.emitter
  await import('../../backend/index.ts')
  port.emitter.emit('message', { data: { type: 'init', pluginId: 'com.github.eNest.game-house', generation: 1, wcId: 7, context: { protocolVersion: 1, appDataPath: mock.root, packagePath: mock.root, appExecPath: process.execPath, pageOrigin: null } } })
  let seq = 100
  const call = (method: string, args: unknown[] = []): Promise<Reply> => new Promise(resolve => {
    const id = ++seq
    pending.set(id, { resolve })
    port.emitter.emit('message', { data: { id, pluginId: 'com.github.eNest.game-house', method, args } })
  })
  return { call, stub, root: mock.root, events, close: async () => { await mock.cleanup(); saveItems([]); saveTasks([]); await flushStore() } }
}

interface PortHandlers {
  onHostRequest(message: unknown): void
  onEvent(event: string, data: unknown): void
  onReply(id: number, ok: boolean, data: unknown, error: string | undefined): void
}

let portSingleton: { emitter: EventEmitter; handlers: PortHandlers } | null = null

/** 后端 ↔ 宿主之间的假通道：后端 → 宿主走 postMessage，宿主 → 后端走 emit('message') */
function sharedPort(): { emitter: EventEmitter; handlers: PortHandlers } {
  if (portSingleton) return portSingleton
  const state = { emitter: null as unknown as EventEmitter, handlers: null as unknown as PortHandlers }
  state.emitter = Object.assign(new EventEmitter(), {
    postMessage(message: unknown) {
      const msg = message as { type?: string; id?: number; ok?: boolean; data?: unknown; error?: string; event?: string }
      if (msg.type === 'host.request') { state.handlers.onHostRequest(message); return }
      if (typeof msg.event === 'string') { state.handlers.onEvent(msg.event, msg.data); return }
      if (typeof msg.id === 'number' && typeof msg.ok === 'boolean') state.handlers.onReply(msg.id, msg.ok, msg.data, msg.error)
    },
  })
  portSingleton = state
  return state
}

/** 轮询直到任务进入给定状态之一 */
async function waitForTask(app: App, id: string, states: string[], timeoutMs = 8000): Promise<Task> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const list = await app.call('task.list')
    const task = ((list.data as Task[] | undefined) ?? []).find(entry => entry.id === id)
    if (task && states.includes(task.state)) return task
    if (Date.now() > deadline) throw new Error(`任务未在 ${timeoutMs}ms 内进入 ${states.join('/')}（当前 ${task?.state ?? '缺失'}：${task?.error || task?.installError || ''}）`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const TERMINAL = ['complete', 'failed', 'login_expired', 'install_failed', 'paused']
const LIST_ARGS = [{ section: 'pc', source: 'ode', page: 1, keyword: '', category: '', sort: '' }]

test('入口端到端：system.hello、设置读写、未知方法', async () => {
  const app = await boot()
  try {
    const hello = await app.call('system.hello')
    assert.equal(hello.ok, true)
    assert.equal((hello.data as { platform: string }).platform, process.platform)
    const saved = await app.call('settings.update', [{ concurrentTasks: 2 }])
    assert.equal(saved.ok, true, saved.error)
    assert.equal((saved.data as { concurrentTasks: number }).concurrentTasks, 2)
    assert.equal(((await app.call('settings.get')).data as { concurrentTasks: number }).concurrentTasks, 2)
    const unknown = await app.call('no.such.method')
    assert.equal(unknown.ok, false)
    assert.match(unknown.error ?? '', /未知后端方法/)
  } finally { await app.close() }
})

test('入口端到端：列表 → 封面令牌换图片 → 详情带资源包且正文已净化', async () => {
  const app = await boot()
  try {
    const page = await app.call('library.list', LIST_ARGS)
    assert.equal(page.ok, true, page.error)
    const items = (page.data as { items: Array<{ id: string; title: string; coverToken: string; favorite: boolean }> }).items
    assert.equal(items.length, 2)
    assert.equal(items[0].title, '星露奇缘')
    assert.match(items[0].coverToken, /^img:[A-Za-z0-9_-]+$/)
    assert.equal(items[1].coverToken, '', '没有封面的条目令牌为空')

    const media = await app.call('media.load', [items[0].coverToken])
    assert.equal(media.ok, true, media.error)
    const payload = media.data as { url: string; mime: string }
    assert.match(payload.url, /^data:image\/png;base64,/)
    assert.equal(payload.mime, 'image/png')

    const detail = await app.call('library.detail', [items[0].id])
    assert.equal(detail.ok, true, detail.error)
    const data = detail.data as { packages: Array<{ id: string; state: string }>; description: string; item: { section: string } }
    assert.equal(data.packages.length, 2, '详情应带出资源包')
    assert.equal(data.packages[0].state, 'ready')
    assert.equal(data.packages[1].state, 'folder')
    assert.ok(!/<script/.test(data.description), '正文里的 script 必须被净化')
    assert.ok(!/javascript:/.test(data.description), 'javascript: 链接必须被净化')
    assert.match(data.description, /img:[A-Za-z0-9_-]+/, '正文图片应改写成令牌')
    assert.equal(data.item.section, 'pc')
  } finally { await app.close() }
})

test('入口端到端：收藏后列表反映状态；登录信息为未登录', async () => {
  const app = await boot()
  try {
    const items = ((await app.call('library.list', LIST_ARGS)).data as { items: Array<{ id: string; favorite: boolean }> }).items
    assert.equal(items[0].favorite, false)
    const fav = await app.call('library.favorite', [items[0].id, true])
    assert.equal(fav.ok, true, fav.error)
    const again = ((await app.call('library.list', LIST_ARGS)).data as { items: Array<{ favorite: boolean }> }).items
    assert.equal(again[0].favorite, true, '收藏后列表要反映')
    const managed = await app.call('library.managed')
    assert.equal(managed.ok, true, managed.error)
    assert.equal(((managed.data as Array<{ item: { id: string } }>)).find(entry => entry.item.id === items[0].id)?.item.id, items[0].id, '收藏的条目要出现在我的游戏里')

    const info = await app.call('auth.info')
    assert.equal(info.ok, true, info.error)
    assert.equal((info.data as { state: string }).state, 'logged-out')
  } finally { await app.close() }
})

test('入口端到端：建任务 → 下载 → 解压 → 完成 → 启动 → 卸载，并推送任务事件', async () => {
  const app = await boot()
  try {
    const items = ((await app.call('library.list', LIST_ARGS)).data as { items: Array<{ id: string }> }).items
    const detail = (await app.call('library.detail', [items[0].id])).data as { packages: Array<{ id: string }> }
    const target = { handleId: 'dir-download', displayPath: 'D:\\Downloads' }
    const created = await app.call('task.create', [{
      itemId: items[0].id, packageIds: [detail.packages[0].id], downloadDir: 'D:\\Downloads', installDir: 'D:\\Games',
      downloadTarget: target, installTarget: target, autoInstall: true, removePackage: true,
    }])
    assert.equal(created.ok, true, created.error)
    const taskId = (created.data as { taskId: string }).taskId

    const done = await waitForTask(app, taskId, TERMINAL)
    assert.equal(done.state, 'complete', done.error || done.installError)
    assert.equal(done.completedBytes, FILE_SIZE)
    // 后端主动推送了进度与完成事件
    const updates = app.events.filter(event => event.event === 'task.updated' && (event.data as Task).id === taskId)
    const finished = app.events.filter(event => event.event === 'task.finished' && (event.data as { task: Task }).task.id === taskId)
    assert.ok(updates.length >= 1, '应有进度事件')
    assert.equal(finished.length, 1, '完成事件恰好一次')
    assert.equal((finished[0].data as { task: Task }).task.state, 'complete')

    // 安装结果：条目有了可执行文件，安装包已删除
    const after = ((await app.call('library.detail', [items[0].id])).data as { item: { installed: boolean } }).item
    assert.equal(after.installed, true, '完成后条目应标记为已安装')
    await assert.rejects(fs.access(app.root + '/xinglu.zip'), '安装包应在安装后被删除')
    const exe = app.root + '/Stardew/Stardew.exe'
    await fs.access(exe)

    // 启动
    const launched = await app.call('library.launch', [items[0].id])
    assert.equal(launched.ok, true, launched.error)
    assert.equal((launched.data as { running: boolean }).running, true)
    const closed = await app.call('library.close', [items[0].id])
    assert.equal(closed.ok, true, closed.error)

    // 卸载
    const uninstalled = await app.call('library.uninstall', [items[0].id])
    assert.equal(uninstalled.ok, true, uninstalled.error)
    assert.equal(await fs.access(exe).then(() => true, () => false), false, '卸载后可执行文件应被删除')
    const final = ((await app.call('library.detail', [items[0].id])).data as { item: { installed: boolean; favorite: boolean } }).item
    assert.equal(final.installed, false, '卸载后不再标记为已安装')
  } finally { await app.close() }
})

test('入口端到端：没有目录句柄时拒绝建任务', async () => {
  const app = await boot()
  try {
    const items = ((await app.call('library.list', LIST_ARGS)).data as { items: Array<{ id: string }> }).items
    const detail = (await app.call('library.detail', [items[0].id])).data as { packages: Array<{ id: string }> }
    const rejected = await app.call('task.create', [{
      itemId: items[0].id, packageIds: [detail.packages[0].id], downloadDir: 'D:\\Downloads', installDir: 'D:\\Games', autoInstall: false, removePackage: true,
    }])
    assert.equal(rejected.ok, false)
    assert.match(rejected.error ?? '', /请选择下载目录/)
    assert.equal(((await app.call('task.list')).data as unknown[]).length, 0, '被拒绝的请求不应留下任务')
  } finally { await app.close() }
})
