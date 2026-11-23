/**
 * 任务状态机单测：在假网络里跑通 建任务 → 解析 → 下载 → 解压 → 完成，
 * 以及暂停 / 继续、安装失败只重试解压、登录过期、删除、目录句柄校验。
 */

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { createMockAdapter } from '../../backend/adapters/mock.ts'
import { setAdapter } from '../../backend/adapters/current.ts'
import { BackendError } from '../../backend/adapters/types.ts'
import { TaskService } from '../../backend/library/taskService.ts'
import { clearEmitters } from '../../backend/library/taskView.ts'
import { flushStore, loadItems, loadTasks, saveAuthMeta, saveItems, saveTasks } from '../../backend/store.ts'
import { ensureItem } from '../../backend/library/items.ts'
import { installHostStub } from './host-stub.ts'

const DOWNLOAD_URL = 'https://cdn.example.com/game.zip'
const FILE_SIZE = 3 * 1024 * 1024 + 12345
const TERMINAL = ['complete', 'failed', 'login_expired', 'install_failed', 'paused']

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(process.env.TEMP ?? os.tmpdir(), 'game-house-task-'))
}

interface Options {
  loggedIn?: boolean
  extractExit?: number
  /** 假网络限速（字节每秒）；0 表示不限速。要在下载途中暂停必须限速 */
  bytesPerSecond?: number
}

/** 建好服务与假环境；dirHandle 是一个已授权的下载目录句柄名 */
/** 清空条目与任务的持久化状态：走真实写入路径，连 store 的待写缓存一起清掉 */
async function resetLibraryState(stub: ReturnType<typeof installHostStub>): Promise<void> {
  saveItems([])
  saveTasks([])
  saveAuthMeta({ sessionRef: '', accountRef: '', passwordRef: '', nickname: '', loginAt: 0 })
  await flushStore()
  stub.kv.delete('tasks')
  stub.kv.delete('library.items')
  stub.kv.delete('auth.meta')
}

async function withHarness(run: (h: { service: TaskService; dirHandle: string; root: string; log: Array<{ url: string; range?: string }> }) => Promise<void>, options: Options = {}): Promise<void> {
  const stub = installHostStub()
  const mock = await createMockAdapter({ bytesPerSecond: options.bytesPerSecond ?? 0 })
  setAdapter(mock.adapter)
  await resetLibraryState(stub)
  clearEmitters()
  const root = await tempRoot()
  stub.handles.set('dir-1', root)
  stub.handles.set('dir-2', path.join(root, 'install'))
  await fs.mkdir(path.join(root, 'install'), { recursive: true })
  mock.network.stream(DOWNLOAD_URL, { size: FILE_SIZE, acceptRanges: true, etag: '"e1"' })
  mock.archives.register('game.zip', {
    outputs: [{ name: 'Game/Game.exe', size: 2048 }, { name: 'Game/data.pak', size: 1024 }],
    exitCode: options.extractExit ?? 0,
  })
  const service = new TaskService({
    resolveFiles: async () => ({
      shareId: 'share-1',
      files: [{ key: 'f1', name: 'game.zip', size: FILE_SIZE, downloaded: 0, state: 'pending', url: DOWNLOAD_URL, etag: '', lastModified: '' }],
    }),
    refreshUrl: async () => ({ url: DOWNLOAD_URL }),
    verifyAccess: async () => options.loggedIn ?? true,
  })
  try {
    await service.init()
    await run({ service, dirHandle: 'dir-1', root, log: mock.network.log })
  } finally {
    await service.shutdown().catch(() => undefined)
    await resetLibraryState(stub)
    clearEmitters()
    await mock.cleanup()
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

const request = (autoInstall: boolean) => ({
  itemId: '', packageIds: [], downloadDir: '', installDir: '', autoInstall, removePackage: true,
  downloadTarget: { handleId: 'dir-1', displayPath: 'D:\\Downloads' },
  installTarget: { handleId: 'dir-2', displayPath: 'D:\\Games' },
})

/** 轮询直到任务进入给定状态之一 */
async function waitFor(service: TaskService, id: string, states: string[], timeoutMs = 8000): Promise<Awaited<ReturnType<typeof service.list>>[number]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = (await service.list()).find(entry => entry.id === id)
    if (task && states.includes(task.state)) return task
    if (Date.now() > deadline) throw new Error(`任务未在 ${timeoutMs}ms 内进入 ${states.join('/')}（当前 ${task?.state ?? '缺失'}）`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('建任务 → 下载 → 解压 → 完成，条目记录可执行文件，安装包被删除', async () => {
  await withHarness(async h => {
    await ensureItem({ id: 'ode:pc:1', title: '测试游戏', kind: 'game', section: 'pc', exeRel: 'Game/Game.exe', cover: 'https://img.example.com/a.jpg' })
    const { taskId } = await h.service.create({ ...request(true), itemId: 'ode:pc:1' })
    const done = await waitFor(h.service, taskId, TERMINAL)
    assert.equal(done.state, 'complete', done.error || done.installError)
    assert.equal(done.totalBytes, FILE_SIZE)
    assert.equal(done.completedBytes, FILE_SIZE)
    assert.equal(done.files[0].state, 'done')

    const item = (await loadItems()).find(entry => entry.id === 'ode:pc:1')
    assert.ok(item?.exePath.endsWith('Game.exe'), `条目应记录可执行文件，实际：${item?.exePath}`)
    assert.ok(item?.installDir.endsWith('install'), `安装目录应是授权的安装路径，实际：${item?.installDir}`)
    await fs.access(item!.exePath)
    await assert.rejects(fs.access(path.join(h.root, 'game.zip')), '安装成功后安装包应被删除')
  })
})

test('关闭自动安装时下载完即完成，安装包保留', async () => {
  await withHarness(async h => {
    const { taskId } = await h.service.create({ ...request(false), removePackage: true })
    const done = await waitFor(h.service, taskId, TERMINAL)
    assert.equal(done.state, 'complete', done.error)
    await fs.access(path.join(h.root, 'game.zip'))
  })
})

test('没有目录句柄时拒绝建任务；句柄无效时提示重新选择', async () => {
  await withHarness(async h => {
    await assert.rejects(
      h.service.create({ itemId: '', packageIds: [], downloadDir: 'D:\\Downloads', installDir: 'D:\\Games', autoInstall: false, removePackage: true }),
      (error: BackendError) => error.code === 'INVALID_ARGUMENT' && /下载目录/.test(error.message),
    )
    await assert.rejects(
      h.service.create({ ...request(false), downloadTarget: { handleId: 'no-such-handle', displayPath: 'D:\\Downloads' } }),
      (error: BackendError) => error.code === 'INVALID_ARGUMENT' && /重新选择/.test(error.message),
    )
    assert.equal((await loadTasks()).length, 0, '被拒绝的请求不应留下任务记录')
  })
})

test('暂停后任务为 paused 且保留进度，继续后完成', async () => {
  await withHarness(async h => {
    const { taskId } = await h.service.create(request(false))
    await waitFor(h.service, taskId, ['downloading'])
    // 等下载真正推进一段（有若干块写盘），记下此时看到的进度
    const moving = await waitProgress(h.service, taskId, 300 * 1024, 10_000)
    await h.service.pause(taskId)
    const paused = await waitFor(h.service, taskId, ['paused'])
    assert.equal(paused.state, 'paused')
    const before = paused.completedBytes
    assert.ok(before < FILE_SIZE, `暂停时应只下了一部分（已下 ${before}）`)
    assert.ok(before >= moving.completedBytes, `暂停后进度不应回退到暂停前看到的位置之前：${before} < ${moving.completedBytes}`)
    // 任务记录里的进度 = 控制文件里已落盘的字节数（进度条显示的与实际能续传的一致）。
    // 缺陷版本在这里把"上次落盘的旧快照"写了回去，任务记录比控制文件少几百 KiB。
    const control = JSON.parse(await fs.readFile(path.join(h.root, 'game.zip.ghctl'), 'utf8'))
    const persisted = (control.done as number[]).length * control.chunkSize + Object.values(control.partial ?? {}).reduce((sum: number, bytes: number) => sum + bytes, 0)
    assert.equal(before, persisted, '任务记录的字节数应等于控制文件里已落盘的字节数')
    await h.service.resume(taskId)
    const done = await waitFor(h.service, taskId, ['complete'])
    assert.equal(done.state, 'complete', done.error)
    assert.equal(done.completedBytes, FILE_SIZE)
  }, { bytesPerSecond: 700 * 1024 })
})

test('排队中的任务也能暂停：置为 paused、不再自动开跑，继续后完成', async () => {
  await withHarness(async h => {
    // 同时只跑 1 个：第二个任务排队
    await h.service.setConcurrency(1)
    const first = await h.service.create(request(false))
    await waitFor(h.service, first.taskId, ['downloading'])
    await waitProgress(h.service, first.taskId, 100 * 1024, 10_000)
    const second = await h.service.create(request(false))
    await waitFor(h.service, second.taskId, ['queued'])
    // 暂停排队中的第二个任务
    const paused = await h.service.pause(second.taskId)
    assert.equal(paused.ok, true)
    const state = await waitFor(h.service, second.taskId, ['paused'])
    assert.equal(state.state, 'paused')
    assert.equal(state.completedBytes, 0, '排队中的任务还没下载，进度为 0')
    // 第一个任务结束后，第二个不能自动开始
    await waitFor(h.service, first.taskId, ['complete'])
    await new Promise(resolve => setTimeout(resolve, 400))
    const still = (await h.service.list()).find(entry => entry.id === second.taskId)
    assert.equal(still?.state, 'paused', '暂停过的排队任务不应在前一个任务结束后自动开跑')
    assert.equal(h.log.filter(entry => entry.range && entry.range !== 'bytes=0-0' && entry.url === DOWNLOAD_URL).length > 0, true)
    // 继续后完成
    assert.equal((await h.service.resume(second.taskId)).ok, true, '排队中暂停的任务应能继续')
    const done = await waitFor(h.service, second.taskId, ['complete'], 15_000)
    assert.equal(done.state, 'complete', done.error)
    assert.equal(done.completedBytes, FILE_SIZE)
  }, { bytesPerSecond: 1500 * 1024 })
})

/** 等任务的已下载字节数达到 atLeast；超时抛错（轮询到条件成立，不睡固定时长） */
async function waitProgress(service: TaskService, id: string, atLeast: number, timeoutMs = 8000): Promise<Awaited<ReturnType<typeof service.list>>[number]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = (await service.list()).find(entry => entry.id === id)
    if (task && (task.completedBytes >= atLeast || TERMINAL.includes(task.state))) return task
    if (Date.now() > deadline) throw new Error(`任务未在 ${timeoutMs}ms 内下载到 ${atLeast} 字节（当前 ${task?.completedBytes ?? '缺失'}）`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('安装失败时包保持已下载，重试只重新解压', async () => {
  await withHarness(async h => {
    const { taskId } = await h.service.create(request(true))
    const failed = await waitFor(h.service, taskId, TERMINAL)
    assert.equal(failed.state, 'install_failed')
    assert.ok(failed.installError.length > 0, '应给出安装失败原因')
    const stored = (await loadTasks()).find(entry => entry.id === taskId)
    assert.equal(stored?.files[0].state, 'done', '包应保持已下载状态')
    await fs.access(path.join(h.root, 'game.zip'))
    const opensBefore = h.log.filter(entry => entry.url === DOWNLOAD_URL).length
    await h.service.retryInstall(taskId)
    await waitFor(h.service, taskId, ['install_failed', 'complete'])
    const opensAfter = h.log.filter(entry => entry.url === DOWNLOAD_URL).length
    assert.equal(opensAfter, opensBefore, '重试安装不应重新下载')
  }, { extractExit: 2 })
})

test('登录过期：任务置为 login_expired，不进入下载', async () => {
  await withHarness(async h => {
    const { taskId } = await h.service.create({ ...request(false), share: { url: 'https://cloud.189.cn/t/abc', accessCode: '1234', title: '分享' } })
    const expired = await waitFor(h.service, taskId, TERMINAL)
    assert.equal(expired.state, 'login_expired')
    assert.equal(h.log.filter(entry => entry.url === DOWNLOAD_URL).length, 0, '未登录时不应发起下载')
  }, { loggedIn: false })
})

test('删除任务并清理文件', async () => {
  await withHarness(async h => {
    const { taskId } = await h.service.create(request(false))
    await waitFor(h.service, taskId, TERMINAL)
    await h.service.remove(taskId, true)
    assert.equal((await loadTasks()).length, 0)
    await assert.rejects(fs.access(path.join(h.root, 'game.zip')))
  })
})

test('init 把上次未完成的任务置为暂停，不自动续传', async () => {
  await withHarness(async h => {
    const { taskId } = await h.service.create(request(false))
    await waitFor(h.service, taskId, ['downloading'])
    // 模拟关闭时没有机会收尾：直接构造一个进行中的记录
    await h.service.shutdown()
    const service = new TaskService({
      resolveFiles: async () => ({ shareId: '', files: [] }),
      refreshUrl: async () => null,
    })
    await service.init()
    const after = (await service.list()).find(entry => entry.id === taskId)
    assert.equal(after?.state, 'paused')
    assert.equal(after?.files[0].state, 'pending')
  }, { bytesPerSecond: 700 * 1024 })
})
