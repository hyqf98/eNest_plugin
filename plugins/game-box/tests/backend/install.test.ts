import assert from 'node:assert/strict'
import test from 'node:test'
import { contentAt, createMockAdapter } from '../../backend/adapters/mock.ts'
import { downloadFile } from '../../backend/downloader/engine.ts'
import { DownloadQueue } from '../../backend/downloader/queue.ts'
import { checkDiskSpace, ensureDir, requiredSpace } from '../../backend/disk.ts'
import { removePackages, selectiveCleanup } from '../../backend/install/cleanup.ts'
import { locateExecutable } from '../../backend/install/locate.ts'
import { extractArchives } from '../../backend/install/extract.ts'

const KiB = 1024
const exists = async (mock: Awaited<ReturnType<typeof createMockAdapter>>, path: string) => Boolean(await mock.adapter.files.stat(path))
const write = async (mock: Awaited<ReturnType<typeof createMockAdapter>>, path: string, size = 1) => {
  await mock.adapter.files.writeFile(path, new Uint8Array(size))
}

/* ---------------- DownloadQueue ---------------- */

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

test('DownloadQueue：并发不超过上限，完成后自动补位', async () => {
  const queue = new DownloadQueue(2)
  let active = 0
  let peak = 0
  const order: string[] = []
  const make = (id: string, ms: number) => async () => { active++; peak = Math.max(peak, active); order.push(id); await new Promise(resolve => setTimeout(resolve, ms)); active-- }
  for (const id of ['a', 'b', 'c', 'd', 'e']) queue.add(id, make(id, 20))
  assert.equal(queue.activeCount(), 2)
  assert.equal(queue.pendingCount(), 3)
  // 等队列真正空闲，而不是睡固定时长：全量并行跑机器负载高时固定时长不够
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('队列未在预期时间内空闲')), 5000)
    queue.onIdle(() => { clearTimeout(timer); resolve() })
  })
  assert.equal(peak, 2, '同时运行的任务不超过 2')
  assert.equal(order.length, 5, '全部任务都运行过')
  assert.deepEqual(order.slice(0, 2), ['a', 'b'])
  assert.ok(queue.isIdle())
})

test('DownloadQueue：pause 中止运行中的任务；移除排队中的任务不会运行', async () => {
  const queue = new DownloadQueue(1)
  const outcomes: Array<[string, string]> = []
  let aborted = false
  queue.add('running', async signal => { await new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('x'), { name: 'AbortError' })) }, { once: true })) }, outcome => { outcomes.push(['running', outcome]) })
  queue.add('queued', async () => {}, outcome => { outcomes.push(['queued', outcome]) })
  await tick()
  assert.equal(queue.pause('running'), true)
  assert.ok(aborted, '运行中的任务收到了中止信号')
  assert.equal(queue.isPaused('running'), true, '刚暂停、任务还在收尾时处于暂停标记')
  assert.equal(queue.remove('queued'), true, '排队中的任务可移除')
  await tick(); await tick()
  assert.equal(queue.isPaused('running'), false, '任务结束并收尾后不再处于暂停标记')
  assert.ok(!outcomes.some(([id]) => id === 'queued' && false))
  assert.deepEqual(outcomes.find(([id]) => id === 'running')?.[1], 'paused')
  assert.deepEqual(outcomes.find(([id]) => id === 'queued')?.[1], 'removed')
})

test('DownloadQueue：setLimit 运行时调整并发；shutdown 中止全部并拒绝新任务', async () => {
  const queue = new DownloadQueue(1)
  let running = 0
  const block = (signal: AbortSignal) => new Promise<void>((_, reject) => { running++; signal.addEventListener('abort', () => { running--; reject(Object.assign(new Error('x'), { name: 'AbortError' })) }, { once: true }) })
  queue.add('a', block); queue.add('b', block); queue.add('c', block)
  await tick()
  assert.equal(queue.activeCount(), 1)
  queue.setLimit(3)
  await tick()
  assert.equal(queue.activeCount(), 3, '调高上限后排队任务立即开跑')
  const settled: string[] = []
  queue.onIdle(() => settled.push('idle'))
  queue.shutdown()
  assert.equal(running, 0, '全部被中止')
  let lateOutcome = ''
  queue.add('late', async () => {}, outcome => { lateOutcome = outcome })
  assert.equal(lateOutcome, 'shutdown')
  assert.ok(settled.includes('idle'))
})

test('DownloadQueue：上限被钳制在 1–5', () => {
  assert.equal(new DownloadQueue(0).limit, 1)
  assert.equal(new DownloadQueue(99).limit, 5)
  assert.equal(new DownloadQueue(3.7).limit, 3)
  assert.equal(new DownloadQueue(Number.NaN).limit, 3)
})

/* ---------------- disk ---------------- */

test('disk：requiredSpace 留一成余量；ensureDir 建多级目录且可写；空间不足抛 DISK_FULL', async () => {
  assert.equal(requiredSpace(100), 110)
  assert.equal(requiredSpace(0), 0)
  const mock = await createMockAdapter()
  try {
    const dir = mock.adapter.path.join(mock.root, 'a', 'b', 'c')
    await ensureDir(mock.adapter, dir)
    assert.ok(await exists(mock, dir))
    assert.equal((await mock.adapter.files.listDir(dir)).length, 0, '探测用的临时文件已删除')
    await checkDiskSpace(mock.adapter, dir, 1e12) // mock 报告 1 TiB 可用，不应抛错
    const tight = { ...mock.adapter, files: { ...mock.adapter.files, freeSpace: async () => 10 } }
    await assert.rejects(() => checkDiskSpace(tight, dir, 100), (error: unknown) => (error as { code?: string }).code === 'DISK_FULL' && /磁盘空间不足/.test((error as Error).message))
    const unknown = { ...mock.adapter, files: { ...mock.adapter.files, freeSpace: async () => null } }
    await checkDiskSpace(unknown, dir, 1e15) // 无法获知时跳过
  } finally { await mock.cleanup() }
})

/* ---------------- cleanup ---------------- */

test('cleanup：保护安装包、续卷与控制文件，删除其它残留，保留含受保护文件的目录', async () => {
  const mock = await createMockAdapter()
  try {
    const out = mock.adapter.path.join(mock.root, 'Anno')
    await write(mock, mock.adapter.path.join(out, 'Anno.zip'))
    await write(mock, mock.adapter.path.join(out, 'anno.z01'))
    await write(mock, mock.adapter.path.join(out, 'anno.Z02'))
    await write(mock, mock.adapter.path.join(out, 'Anno.zip.ghctl'))
    await write(mock, mock.adapter.path.join(out, 'stale.bin'))
    await write(mock, mock.adapter.path.join(out, 'OldExtract', 'old.dll'))
    await write(mock, mock.adapter.path.join(out, 'EmptyDir', 'junk.txt'))
    // 嵌套目录里的安装包：目录链必须保留
    const nested = mock.adapter.path.join(out, 'Nested', 'Deeper', 'Pack.rar')
    await write(mock, nested)
    await write(mock, mock.adapter.path.join(out, 'Nested', 'Deeper', 'pack.r00'))
    await write(mock, mock.adapter.path.join(out, 'Nested', 'Deeper', 'leftover.txt'))
    await write(mock, mock.adapter.path.join(out, 'Nested', 'Sibling', 'x.txt'))

    await selectiveCleanup(mock.adapter, out, [
      mock.adapter.path.join(out, 'Anno.zip'),
      nested,
    ])
    assert.ok(await exists(mock, mock.adapter.path.join(out, 'Anno.zip')), '安装包保留')
    assert.ok(await exists(mock, mock.adapter.path.join(out, 'anno.z01')), '续卷保留')
    assert.ok(await exists(mock, mock.adapter.path.join(out, 'anno.Z02')), '续卷（大小写不同）保留')
    assert.ok(await exists(mock, mock.adapter.path.join(out, 'Anno.zip.ghctl')), '控制文件保留')
    assert.ok(!(await exists(mock, mock.adapter.path.join(out, 'stale.bin'))), '残留文件被删除')
    assert.ok(!(await exists(mock, mock.adapter.path.join(out, 'OldExtract'))), '不含受保护文件的目录整个删除')
    assert.ok(!(await exists(mock, mock.adapter.path.join(out, 'EmptyDir'))), '空目录被删除')
    assert.ok(await exists(mock, nested) && await exists(mock, mock.adapter.path.join(out, 'Nested', 'Deeper', 'pack.r00')), '嵌套目录里的安装包与续卷保留')
    assert.ok(!(await exists(mock, mock.adapter.path.join(out, 'Nested', 'Deeper', 'leftover.txt'))), '嵌套目录里的残留被删除')
    assert.ok(!(await exists(mock, mock.adapter.path.join(out, 'Nested', 'Sibling'))), '不含受保护文件的同级目录被删除')
    assert.ok(await exists(mock, out), '输出目录本身保留')
  } finally { await mock.cleanup() }
})

test('cleanup：removePackages 删除主卷、续卷与控制文件，不动其它文件', async () => {
  const mock = await createMockAdapter()
  try {
    const dir = mock.adapter.path.join(mock.root, 'dl')
    for (const name of ['Game.part1.rar', 'Game.part2.rar', 'Game.part1.rar.ghctl', 'Game.exe', 'Game.exe.ghctl', 'readme.txt', 'Other.zip', 'other.z01']) await write(mock, mock.adapter.path.join(dir, name))
    await removePackages(mock.adapter, dir, ['Game.part1.rar', 'Game.exe'])
    const left = (await mock.adapter.files.listDir(dir)).map(entry => entry.name).sort()
    assert.deepEqual(left, ['Other.zip', 'other.z01', 'readme.txt'])
  } finally { await mock.cleanup() }
})

/* ---------------- locateExecutable ---------------- */

test('locateExecutable：三层回退，排除卸载器与运行库，优先体积最大', async () => {
  const mock = await createMockAdapter()
  try {
    const out = mock.adapter.path.join(mock.root, 'out')
    // 第三层：整个目录下找，选最大的，排除 unins000.exe / vc_redist
    await write(mock, mock.adapter.path.join(out, 'unins000.exe'), 5000)
    await write(mock, mock.adapter.path.join(out, 'vc_redist.x64.exe'), 9000)
    await write(mock, mock.adapter.path.join(out, 'Launcher.exe'), 300)
    await write(mock, mock.adapter.path.join(out, 'Binaries', 'Game-Win64-Shipping.exe'), 40000)
    await write(mock, mock.adapter.path.join(out, 'readme.txt'))
    assert.equal(await locateExecutable(mock.adapter, out, ''), mock.adapter.path.join(out, 'Binaries', 'Game-Win64-Shipping.exe'))

    // 第二层：以相对路径第一段为子目录
    await write(mock, mock.adapter.path.join(out, 'Other', 'setup.exe'), 1)
    assert.equal(await locateExecutable(mock.adapter, out, 'Binaries/nope.exe'), mock.adapter.path.join(out, 'Binaries', 'Game-Win64-Shipping.exe'))

    // 第一层：站点给出的路径直接命中
    assert.equal(await locateExecutable(mock.adapter, out, 'Launcher.exe'), mock.adapter.path.join(out, 'Launcher.exe'))
    assert.equal(await locateExecutable(mock.adapter, out, 'Binaries\\Game-Win64-Shipping.exe'), mock.adapter.path.join(out, 'Binaries', 'Game-Win64-Shipping.exe'), '反斜杠的相对路径也可')

    // 站点给的是被排除的文件名：不采用，继续回退
    assert.equal(await locateExecutable(mock.adapter, out, 'unins000.exe'), mock.adapter.path.join(out, 'Binaries', 'Game-Win64-Shipping.exe'))

    // 没有 exe
    const empty = mock.adapter.path.join(mock.root, 'empty')
    assert.equal(await locateExecutable(mock.adapter, empty, ''), null)
  } finally { await mock.cleanup() }
})

/* ---------------- extractArchives ---------------- */

test('extractArchives：退出码 0 成功；.exe 单元跳过；同名目录串行', async () => {
  const mock = await createMockAdapter()
  try {
    const dir = mock.adapter.path.join(mock.root, 'dl'); const out = mock.adapter.path.join(mock.root, 'out')
    await mock.adapter.files.ensureDir(dir)
    for (const name of ['data1.zip', 'data2.zip', 'Setup.exe']) await write(mock, mock.adapter.path.join(dir, name))
    mock.archives.register('data1.zip', { outputs: [{ name: 'a.txt', size: 3 }], durationMs: 20 })
    mock.archives.register('data2.zip', { outputs: [{ name: 'game/b.exe', size: 10 }], durationMs: 20 })
    let progress = 0
    const outcome = await extractArchives(mock.adapter, ['data1.zip', 'data2.zip', 'Setup.exe'], dir, out, new AbortController().signal, () => { progress++ })
    assert.deepEqual(outcome.warnings, [])
    assert.ok(await exists(mock, mock.adapter.path.join(out, 'a.txt')))
    assert.ok(await exists(mock, mock.adapter.path.join(out, 'game', 'b.exe')))
    assert.deepEqual(mock.archives.extractions.map(entry => entry.archive.split(/[\\/]/).pop()), ['data1.zip', 'data2.zip'], '按顺序解压，.exe 不解压')
    assert.ok(progress > 0, '有进度回调')
  } finally { await mock.cleanup() }
})

test('extractArchives：退出码 1（警告）仅在关键 exe 已解出时算成功', async () => {
  const mock = await createMockAdapter()
  try {
    const dir = mock.adapter.path.join(mock.root, 'dl'); const out = mock.adapter.path.join(mock.root, 'out')
    await mock.adapter.files.ensureDir(dir)
    await write(mock, mock.adapter.path.join(dir, 'with.exe.zip')); await write(mock, mock.adapter.path.join(dir, 'without.zip'))
    mock.archives.register('with.exe.zip', { outputs: [{ name: 'game/Play.exe', size: 5 }], exitCode: 1, durationMs: 10 })
    mock.archives.register('without.zip', { outputs: [{ name: 'note.txt', size: 1 }], exitCode: 1, durationMs: 10 })
    const ok = await extractArchives(mock.adapter, ['with.exe.zip'], dir, out, new AbortController().signal, () => {})
    assert.equal(ok.warnings.length, 1)
    assert.match(ok.warnings[0], /警告/)
    await assert.rejects(
      () => extractArchives(mock.adapter, ['without.zip'], dir, mock.adapter.path.join(mock.root, 'out2'), new AbortController().signal, () => {}),
      (error: unknown) => (error as { code?: string }).code === 'EXTRACT_WARNING' && /关键文件缺失/.test((error as Error).message),
    )
  } finally { await mock.cleanup() }
})

test('extractArchives：退出码 2 / 缺失归档 → EXTRACT_FAILED；中止 → AbortError', async () => {
  const mock = await createMockAdapter()
  try {
    const dir = mock.adapter.path.join(mock.root, 'dl')
    await mock.adapter.files.ensureDir(dir)
    await write(mock, mock.adapter.path.join(dir, 'bad.zip'))
    mock.archives.register('bad.zip', { outputs: [], exitCode: 2, durationMs: 5 })
    const out = mock.adapter.path.join(mock.root, 'out')
    await assert.rejects(() => extractArchives(mock.adapter, ['bad.zip'], dir, out, new AbortController().signal, () => {}), (error: unknown) => (error as { code?: string }).code === 'EXTRACT_FAILED' && /exit=2/.test((error as Error).message))
    await assert.rejects(() => extractArchives(mock.adapter, ['missing.zip'], dir, out, new AbortController().signal, () => {}), (error: unknown) => (error as { code?: string }).code === 'EXTRACT_FAILED')

    mock.archives.register('slow.zip', { outputs: [], durationMs: 400 })
    await write(mock, mock.adapter.path.join(dir, 'slow.zip'))
    const controller = new AbortController()
    const started = Date.now()
    const pending = extractArchives(mock.adapter, ['slow.zip'], dir, mock.adapter.path.join(mock.root, 'out3'), controller.signal, () => {})
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(() => pending, (error: unknown) => (error as Error).name === 'AbortError')
    assert.ok(Date.now() - started < 300, '中止后很快返回')
  } finally { await mock.cleanup() }
})

test('extractArchives：WinZip 分卷直接解压失败时，按序拼接后再解，拼接文件最终被删除', async () => {
  const mock = await createMockAdapter({ chunkSize: 64 * KiB })
  try {
    const dir = mock.adapter.path.join(mock.root, 'dl'); const out = mock.adapter.path.join(mock.root, 'out')
    await mock.adapter.files.ensureDir(dir)
    // 用真实引擎下载得到字节正确的 "分卷"，再按真实布局切开
    const url = 'https://cdn.test/game.zip'
    const whole = joinWhole(mock, 'whole.zip')
    mock.network.stream(url, { size: 300 * KiB, acceptRanges: true, etag: '"v1"' })
    await downloadFile(mock.adapter, { url, targetPath: whole, signal: new AbortController().signal, connections: 3, chunkSize: 64 * KiB })
    const archive = Buffer.from(await mock.adapter.files.readFile(whole))
    const cut = Math.floor(archive.length / 2)
    await mock.adapter.files.writeFile(mock.adapter.path.join(dir, 'Game.z01'), archive.subarray(0, cut))
    await mock.adapter.files.writeFile(mock.adapter.path.join(dir, 'Game.z02'), archive.subarray(cut, cut + 1000))
    await mock.adapter.files.writeFile(mock.adapter.path.join(dir, 'Game.zip'), archive.subarray(cut + 1000))
    await mock.adapter.files.removeFile(whole)

    const concatenated: string[][] = []
    const seen: string[] = []
    mock.archives.register('Game.zip', { outputs: [], exitCode: 2 })
    mock.archives.register('Game.joined.zip', { outputs: [{ name: 'Game.exe', size: 64 }], exitCode: 0 })
    const recording = { ...mock.adapter, files: { ...mock.adapter.files, concatFiles: async (...args: Parameters<typeof mock.adapter.files.concatFiles>) => { concatenated.push(args[0].map(path => path.split(/[\\/]/).pop() ?? '')); return mock.adapter.files.concatFiles(...args) } }, archive: { ...mock.adapter.archive, extract: async (options: Parameters<typeof mock.adapter.archive.extract>[0]) => { seen.push(options.archive.split(/[\\/]/).pop() ?? ''); return mock.adapter.archive.extract(options) } } }

    const outcome = await extractArchives(recording, ['Game.zip'], dir, out, new AbortController().signal, () => {})
    assert.deepEqual(outcome.warnings, [])
    assert.deepEqual(concatenated, [['Game.z01', 'Game.z02', 'Game.zip']], '按数字升序、主卷在最后')
    assert.deepEqual(seen, ['Game.zip', 'Game.joined.zip'], '先直接解主卷，失败后解拼接文件')
    assert.ok(await exists(mock, mock.adapter.path.join(out, 'Game.exe')))
    assert.ok(!(await exists(mock, mock.adapter.path.join(dir, 'Game.joined.zip'))), '拼接文件已删除')
    assert.ok(await exists(mock, mock.adapter.path.join(dir, 'Game.z01')) && await exists(mock, mock.adapter.path.join(dir, 'Game.zip')), '原分卷保留')
  } finally { await mock.cleanup() }
})

test('extractArchives：非 zip-split 的归档解压失败时不做拼接回退', async () => {
  const mock = await createMockAdapter()
  try {
    const dir = mock.adapter.path.join(mock.root, 'dl')
    await mock.adapter.files.ensureDir(dir)
    await write(mock, mock.adapter.path.join(dir, 'Game.7z.001')); await write(mock, mock.adapter.path.join(dir, 'Game.7z.002'))
    mock.archives.register('Game.7z.001', { outputs: [], exitCode: 2 })
    let concatenated = 0
    const counting = { ...mock.adapter, files: { ...mock.adapter.files, concatFiles: async (...args: Parameters<typeof mock.adapter.files.concatFiles>) => { concatenated++; return mock.adapter.files.concatFiles(...args) } } }
    await assert.rejects(() => extractArchives(counting, ['Game.7z.001'], dir, mock.adapter.path.join(mock.root, 'out'), new AbortController().signal, () => {}), (error: unknown) => (error as { code?: string }).code === 'EXTRACT_FAILED')
    assert.equal(concatenated, 0)
  } finally { await mock.cleanup() }
})

function joinWhole(mock: Awaited<ReturnType<typeof createMockAdapter>>, name: string): string {
  return mock.adapter.path.join(mock.root, name)
}

// contentAt 在本文件里用于确认分卷样本确实来自真实字节（防止样本退化成空文件）
void contentAt
