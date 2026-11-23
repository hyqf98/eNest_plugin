/**
 * 条目库与启动单测：ensureItem 不覆盖用户数据、listManaged 合并去重、setFavorite 往返、
 * launch/close/uninstall 的基本链路。不联网、不起真进程（mock 适配层）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockAdapter } from '../../backend/adapters/mock.ts'
import { getAdapter, setAdapter } from '../../backend/adapters/current.ts'
import { installHostStub } from './host-stub.ts'
import { ensureItem, setFavorite, listManaged, requireItem, clearInstall, registerAndMerge, mergeUserState } from '../../backend/library/items.ts'
import { launch, close, runningIds } from '../../backend/library/launch.ts'
import { flushStore, loadItems, loadTasks, saveItems, saveTasks, removeItem, upsertItem } from '../../backend/store.ts'
import { BackendError } from '../../backend/adapters/types.ts'
import { caesar3 } from '../../backend/crypto.ts'
import { sanitizeArticle } from '../../backend/imageProxy.ts'

/** 清空条目与任务的持久化状态：走真实写入路径，连 store 的待写缓存一起清掉 */
async function resetLibraryState(stub: ReturnType<typeof installHostStub>): Promise<void> {
  saveItems([])
  saveTasks([])
  await flushStore()
  stub.kv.delete('library.items')
  stub.kv.delete('tasks')
}

/** run 拿到 mock 的临时根目录：测试文件一律建在里面（随 cleanup 一起删除），不要往进程当前目录写 */
async function withMock(run: (root: string) => Promise<void>): Promise<void> {
  const stub = installHostStub()
  const { adapter, root, cleanup } = await createMockAdapter()
  setAdapter(adapter)
  await resetLibraryState(stub)
  runningIds().clear()
  try {
    await run(root)
  } finally {
    runningIds().clear()
    await resetLibraryState(stub)
    await cleanup()
    setAdapter(getAdapter())
  }
}

test('ensureItem 登记新条目并保留已有 favorite/exePath', async () => {
  await withMock(async () => {
    const created = await ensureItem({ id: 'ode:4992070', kind: 'game', section: 'pc', source: 'ode', sourceId: '4992070', title: '测试游戏', cover: 'https://cdn.example.com/x.jpg' })
    assert.equal(created.favorite, false)
    assert.equal(created.exePath, '')

    // 用户收藏并指定 exe
    await setFavorite('ode:4992070', true)
    await upsertItem({ id: 'ode:4992070', exePath: 'D:\\Games\\Test\\Game.exe', installDir: 'D:\\Games\\Test' })

    // 再次 ensure（例如重新浏览到该条目）：用户数据不被覆盖
    const again = await ensureItem({ id: 'ode:4992070', kind: 'game', section: 'pc', source: 'ode', sourceId: '4992070', title: '测试游戏（改名后）' })
    const stored = await requireItem('ode:4992070')
    assert.equal(stored.favorite, true)
    assert.equal(stored.exePath, 'D:\\Games\\Test\\Game.exe')
    assert.equal(stored.installDir, 'D:\\Games\\Test')
    // 展示字段允许更新
    assert.equal(stored.title, '测试游戏（改名后）')
    assert.equal(again.id, 'ode:4992070')
  })
})

test('setFavorite 往返', async () => {
  await withMock(async () => {
    await ensureItem({ id: 'ode:100', title: '游戏A' })
    await setFavorite('ode:100', true)
    assert.equal((await requireItem('ode:100')).favorite, true)
    await setFavorite('ode:100', false)
    assert.equal((await requireItem('ode:100')).favorite, false)
    // 不存在的条目抛 NOT_FOUND
    await assert.rejects(setFavorite('ode:missing', true), (error: BackendError) => error.code === 'NOT_FOUND')
  })
})

test('registerAndMerge：登记浏览到的条目，并把收藏 / 已安装状态合并回列表', async () => {
  await withMock(async () => {
    // 用户之前收藏并安装过 ode:pc:1
    await ensureItem({ id: 'ode:pc:1', title: '旧标题', kind: 'game', section: 'pc' })
    await setFavorite('ode:pc:1', true)
    await upsertItem({ id: 'ode:pc:1', exePath: 'D:\\Games\\One\\Game.exe', installDir: 'D:\\Games\\One' })
    // ode:pc:2 只收藏
    await ensureItem({ id: 'ode:pc:2', title: '游戏二', kind: 'game', section: 'pc' })
    await setFavorite('ode:pc:2', true)

    const source = [
      { id: 'ode:pc:1', kind: 'game' as const, section: 'pc' as const, source: 'ode', sourceId: '1', title: '站点改名后的标题', subtitle: '', cover: 'https://img/1.jpg', coverToken: '', category: '', sizeText: '', meta: [], favorite: false, installed: false },
      { id: 'ode:pc:2', kind: 'game' as const, section: 'pc' as const, source: 'ode', sourceId: '2', title: '游戏二', subtitle: '', cover: '', coverToken: '', category: '', sizeText: '', meta: [], favorite: false, installed: false },
      { id: 'ode:pc:3', kind: 'game' as const, section: 'pc' as const, source: 'ode', sourceId: '3', title: '没见过的新游戏', subtitle: '', cover: '', coverToken: '', category: '', sizeText: '', meta: [], favorite: false, installed: false },
    ]
    const merged = await registerAndMerge(source)
    assert.equal(merged[0].favorite, true, '收藏状态要合并回来')
    assert.equal(merged[0].installed, true, '已安装状态要合并回来')
    assert.equal(merged[0].title, '站点改名后的标题', '展示字段用数据源的最新值')
    assert.equal(merged[1].favorite, true)
    assert.equal(merged[1].installed, false)
    assert.equal(merged[2].favorite, false)
    // 新条目已被登记，之后对它收藏不会报"条目不存在"
    assert.ok(await requireItem('ode:pc:3'))
    await setFavorite('ode:pc:3', true)
    const stored = await requireItem('ode:pc:1')
    assert.equal(stored.favorite, true, '站点改名不能丢收藏')
    assert.equal(stored.exePath, 'D:\\Games\\One\\Game.exe', '站点改名不能丢安装信息')
    assert.equal(stored.title, '站点改名后的标题')

    const detail = await mergeUserState({ ...source[1], favorite: false, installed: false })
    assert.equal(detail.favorite, true, '详情页同样要合并用户状态')
  })
})

test('listManaged 合并收藏/已安装/有任务的条目且不重复', async () => {
  await withMock(async () => {
    await ensureItem({ id: 'ode:fav', title: '收藏未安装', source: 'ode', sourceId: 'fav' })
    await setFavorite('ode:fav', true)

    await ensureItem({ id: 'ode:installed', title: '已安装', source: 'ode', sourceId: 'installed' })
    await upsertItem({ id: 'ode:installed', exePath: 'D:\\Games\\B\\B.exe', installDir: 'D:\\Games\\B' })

    await ensureItem({ id: 'ode:tasked', title: '有任务', source: 'ode', sourceId: 'tasked' })

    await ensureItem({ id: 'ode:browsing', title: '只是浏览过（不应出现在我的游戏）', source: 'ode', sourceId: 'browsing' })

    const entries = await listManaged([
      { itemId: 'ode:tasked', state: 'downloading' },
      { itemId: 'ode:fav', state: 'none' },
    ])
    const ids = entries.map(entry => entry.item.id)
    assert.ok(ids.includes('ode:fav'))
    assert.ok(ids.includes('ode:installed'))
    assert.ok(ids.includes('ode:tasked'))
    assert.ok(!ids.includes('ode:browsing'))
    // 无重复
    assert.equal(new Set(ids).size, ids.length)
    // 任务状态映射
    const tasked = entries.find(entry => entry.item.id === 'ode:tasked')
    assert.equal(tasked?.state, 'downloading')
    assert.equal(tasked?.running, false)
    // 已安装的 exePath 透出
    const installed = entries.find(entry => entry.item.id === 'ode:installed')
    assert.equal(installed?.exePath, 'D:\\Games\\B\\B.exe')
    assert.equal(installed?.state, 'none')
    // installed 标志
    assert.equal(installed?.item.installed, true)
    assert.equal(entries.find(entry => entry.item.id === 'ode:fav')?.item.installed, false)
  })
})

test('listManaged 的 running 标记来自 launch 运行表', async () => {
  await withMock(async (root) => {
    const adapter = getAdapter()
    // 准备一个真实存在的 exe（mock 文件层是真的），建在 mock 的临时目录里
    const exe = adapter.path.join(root, 'game.exe')
    await adapter.files.writeFile(exe, new Uint8Array([1]))
    await ensureItem({ id: 'ode:run', title: '运行中游戏' })
    await upsertItem({ id: 'ode:run', exePath: exe, installDir: adapter.path.dirname(exe) })

    await launch('ode:run')
    assert.ok(runningIds().has('ode:run'))

    const entries = await listManaged([{ itemId: 'ode:run', state: 'complete' }])
    const entry = entries.find(item => item.item.id === 'ode:run')
    assert.equal(entry?.running, true)

    // 关闭：进程身份核对后结束
    const result = await close('ode:run')
    assert.equal(result.running, false)
    assert.ok(!runningIds().has('ode:run'))
  })
})

test('launch 没有 exePath 抛 NO_EXE', async () => {
  await withMock(async () => {
    await ensureItem({ id: 'ode:noexe', title: '未安装' })
    await assert.rejects(launch('ode:noexe'), (error: BackendError) => error.code === 'NO_EXE')
  })
})

test('launch 重复启动报 ALREADY_RUNNING', async () => {
  await withMock(async (root) => {
    const adapter = getAdapter()
    const exe = adapter.path.join(root, 'dup.exe')
    await adapter.files.writeFile(exe, new Uint8Array([1]))
    await ensureItem({ id: 'ode:dup', title: '重复启动' })
    await upsertItem({ id: 'ode:dup', exePath: exe })
    await launch('ode:dup')
    await assert.rejects(launch('ode:dup'), (error: BackendError) => error.code === 'ALREADY_RUNNING')
    await close('ode:dup')
  })
})

test('游戏自己退出后点关闭：报未运行并清出运行表，而不是"仍在运行"', async () => {
  await withMock(async (root) => {
    const adapter = getAdapter()
    const exe = adapter.path.join(root, 'quit.exe')
    await adapter.files.writeFile(exe, new Uint8Array([1]))
    await ensureItem({ id: 'ode:quit', title: '已自行退出' })
    await upsertItem({ id: 'ode:quit', exePath: exe })
    await launch('ode:quit')
    // 玩家在游戏里点了退出：真实适配层此时读不到进程身份，返回 gone
    const original = adapter.processes.terminate.bind(adapter.processes)
    adapter.processes.terminate = async () => 'gone'
    try {
      const result = await close('ode:quit')
      assert.deepEqual(result, { running: false })
      assert.ok(!runningIds().has('ode:quit'), '应清出运行表')
    } finally {
      adapter.processes.terminate = original
    }
  })
})

test('进程结束不了（refused）：仍报运行中，且保留运行表以便再试', async () => {
  await withMock(async (root) => {
    const adapter = getAdapter()
    const exe = adapter.path.join(root, 'stuck.exe')
    await adapter.files.writeFile(exe, new Uint8Array([1]))
    await ensureItem({ id: 'ode:stuck', title: '结束失败' })
    await upsertItem({ id: 'ode:stuck', exePath: exe })
    await launch('ode:stuck')
    const original = adapter.processes.terminate.bind(adapter.processes)
    adapter.processes.terminate = async () => 'refused'
    try {
      assert.deepEqual(await close('ode:stuck'), { running: true })
      assert.ok(runningIds().has('ode:stuck'), '结束失败时保留运行表')
    } finally {
      adapter.processes.terminate = original
    }
    await close('ode:stuck')
  })
})

test('uninstall 用户取消抛 CANCELLED 且不清数据', async () => {
  await withMock(async () => {
    const stub = installHostStub()
    await ensureItem({ id: 'ode:cancel', title: '取消卸载' })
    await setFavorite('ode:cancel', true)
    await upsertItem({ id: 'ode:cancel', exePath: 'D:\\x\\Game\\g.exe', installDir: 'D:\\x' })
    stub.confirmAnswer = false
    const { uninstall } = await import('../../backend/library/launch.ts')
    await assert.rejects(uninstall('ode:cancel'), (error: BackendError) => error.code === 'CANCELLED')
    const kept = await requireItem('ode:cancel')
    assert.equal(kept.exePath, 'D:\\x\\Game\\g.exe', '取消后安装信息必须原样保留')
    assert.equal(kept.favorite, true)
    assert.equal(stub.confirms.length, 1, '应且只应弹一次确认')
  })
})

test('uninstall 只删本条目独占的子目录，安装根目录里的其它内容不受影响', async () => {
  const stub = installHostStub()
  const mock = await createMockAdapter()
  setAdapter(mock.adapter)
  const { adapter } = mock
  try {
    const root = adapter.path.join(mock.root, 'Games')
    const mine = adapter.path.join(root, 'MyGame')
    const other = adapter.path.join(root, 'OtherGame')
    await adapter.files.ensureDir(adapter.path.join(mine, 'data'))
    await adapter.files.ensureDir(other)
    await adapter.files.writeFile(adapter.path.join(mine, 'Game.exe'), new Uint8Array(4))
    await adapter.files.writeFile(adapter.path.join(mine, 'data', 'pak.pak'), new Uint8Array(4))
    await adapter.files.writeFile(adapter.path.join(other, 'Other.exe'), new Uint8Array(4))
    await adapter.files.writeFile(adapter.path.join(root, 'loose.txt'), new Uint8Array(4))
    await ensureItem({ id: 'ode:u1', title: '要卸载的游戏' })
    await setFavorite('ode:u1', true)
    await upsertItem({ id: 'ode:u1', exePath: adapter.path.join(mine, 'Game.exe'), installDir: root })
    stub.confirmAnswer = true
    const { uninstall } = await import('../../backend/library/launch.ts')
    await uninstall('ode:u1')

    assert.equal(await adapter.files.isDirectory(mine), false, '本游戏的子目录应被删除')
    assert.equal(await adapter.files.isDirectory(other), true, '同一安装根目录下的其它游戏必须保留')
    assert.ok(await adapter.files.stat(adapter.path.join(other, 'Other.exe')), '其它游戏的文件必须保留')
    assert.ok(await adapter.files.stat(adapter.path.join(root, 'loose.txt')), '根目录下的其它文件必须保留')
    const after = await requireItem('ode:u1')
    assert.equal(after.exePath, '', '卸载后清掉可执行文件路径')
    assert.equal(after.favorite, true, '收藏保留')
  } finally {
    await mock.cleanup()
  }
})

test('uninstall：exe 直接在安装根目录时不删根目录，只删登记过的文件', async () => {
  const stub = installHostStub()
  const mock = await createMockAdapter()
  setAdapter(mock.adapter)
  const { adapter } = mock
  try {
    const root = adapter.path.join(mock.root, 'Loose')
    await adapter.files.ensureDir(root)
    const exe = adapter.path.join(root, 'Game.exe')
    await adapter.files.writeFile(exe, new Uint8Array(4))
    await adapter.files.writeFile(adapter.path.join(root, 'unrelated.dll'), new Uint8Array(4))
    await ensureItem({ id: 'ode:u2', title: '散装游戏' })
    await upsertItem({ id: 'ode:u2', exePath: exe, installDir: root })
    await saveTasks([{ id: 't1', itemId: 'ode:u2', kind: 'game', title: '散装游戏', cover: '', state: 'complete', shareUrl: '', accessCode: '', shareId: '', files: [{ key: 'k', name: 'Game.exe', size: 4, downloaded: 4, state: 'done', url: '', etag: '', lastModified: '' }], downloadDir: root, installDir: root, exeRel: '', exePath: exe, autoInstall: false, removePackage: false, error: '', installError: '', createdAt: 1, finishedAt: 2 }])
    stub.confirmAnswer = true
    const { uninstall } = await import('../../backend/library/launch.ts')
    await uninstall('ode:u2')

    assert.equal(await adapter.files.isDirectory(root), true, '根目录不能被整个删除')
    assert.equal(await adapter.files.stat(exe), null, '登记过的文件应被删除')
    assert.ok(await adapter.files.stat(adapter.path.join(root, 'unrelated.dll')), '无法确定归属的文件必须保留')
  } finally {
    await mock.cleanup()
  }
})

test('clearInstall 卸载后清安装字段或删除条目', async () => {
  await withMock(async () => {
    await ensureItem({ id: 'ode:keep', title: '保留条目' })
    await setFavorite('ode:keep', true)
    await upsertItem({ id: 'ode:keep', exePath: 'D:\\x\\g.exe', installDir: 'D:\\x' })
    await clearInstall('ode:keep', false)
    const kept = await requireItem('ode:keep')
    assert.equal(kept.exePath, '')
    assert.equal(kept.installDir, '')
    assert.equal(kept.favorite, true)

    await clearInstall('ode:keep', true)
    const list = await loadItems()
    assert.ok(!list.some(entry => entry.id === 'ode:keep'))
  })
})

test('任务记录删除留档完整（StoredTask 与条目联动）', async () => {
  await withMock(async () => {
    await ensureItem({ id: 'ode:task', title: '任务条目' })
    saveTasks([{
      id: 'task_1', itemId: 'ode:task', kind: 'game', title: '任务条目', cover: '', state: 'complete',
      shareUrl: '', accessCode: '', shareId: '', files: [{ key: '1', name: 'Game.7z.001', size: 100, downloaded: 100, state: 'done', url: '', etag: '', lastModified: '' }],
      downloadDir: 'D:\\dl', installDir: 'D:\\in', exeRel: '', autoInstall: true, removePackage: true, error: '', installError: '',
      createdAt: 0, finishedAt: 0,
    }])
    const tasks = await loadTasks()
    assert.equal(tasks.length, 1)
    const entries = await listManaged(tasks.map(task => ({ itemId: task.itemId, state: task.state })))
    assert.ok(entries.some(entry => entry.item.id === 'ode:task' && entry.state === 'complete'))
  })
})

/* ---------------- 附带的小工具单测 ---------------- */

test('sanitizeArticle 净化正文并改写 img 为 token', () => {
  const dirty = '<p onclick="hack()">段落<script>bad()</script><iframe src="x"></iframe><img src="https://img.example.com/a.jpg"><a href="javascript:alert(1)">链接</a><b>保留</b></p>'
  const clean = sanitizeArticle(dirty)
  assert.ok(!clean.includes('<script'))
  assert.ok(!clean.includes('<iframe'))
  assert.ok(!clean.includes('onclick'))
  assert.ok(!clean.includes('javascript:'))
  assert.ok(clean.includes('img:'))
  assert.ok(clean.includes('<b>保留</b>'))
})

test('凯撒+3 在条目库测试里仍可引用（冒烟）', () => {
  assert.equal(caesar3('ab'), 'de')
})
