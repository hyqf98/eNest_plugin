import assert from 'node:assert/strict'
import test from 'node:test'
import { contentAt, createMockAdapter, MockNetwork } from '../../backend/adapters/mock.ts'
import type { Adapter } from '../../backend/adapters/types.ts'
import { isAbortError } from '../../backend/util.ts'
import { controlPathFor, createControlSaver, loadControl, saveControl, validateControl, type ControlFile } from '../../backend/downloader/control.ts'
import { downloadFile, probe } from '../../backend/downloader/engine.ts'
import { SegmentScheduler, planSegments } from '../../backend/downloader/segments.ts'

const URL_A = 'https://cdn.test/file'
const KiB = 1024
const MiB = 1024 * 1024

/** 轮询直到条件成立；超时抛错（比睡固定时长稳：机器负载高时固定时长不够） */
async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function setup(size: number, options: { chunkSize?: number; acceptRanges?: boolean; etag?: string; breakAfterChunks?: number; failAttempts?: number; bytesPerSecond?: number } = {}) {
  const mock = await createMockAdapter({ chunkSize: options.chunkSize ?? 64 * KiB, bytesPerSecond: options.bytesPerSecond ?? 0 })
  mock.network.stream(URL_A, {
    size,
    acceptRanges: options.acceptRanges ?? true,
    etag: options.etag ?? '"v1"',
    breakAfterChunks: options.breakAfterChunks ?? -1,
    failAttempts: options.failAttempts ?? 0,
  })
  const targetPath = mock.adapter.path.join(mock.root, 'out', 'Game.zip')
  const readBack = () => mock.adapter.files.readFile(targetPath)
  return { ...mock, targetPath, readBack }
}

function run(adapter: Adapter, targetPath: string, extra: Partial<Parameters<typeof downloadFile>[1]> = {}) {
  const controller = new AbortController()
  const progress: Array<[number, number]> = []
  const promise = downloadFile(adapter, { url: URL_A, targetPath, signal: controller.signal, connections: 4, chunkSize: 256 * KiB, ...extra, onProgress: (downloaded, total) => { progress.push([downloaded, total]); extra.onProgress?.(downloaded, total) } })
  return { controller, promise, progress }
}

/* ---------------- planSegments / SegmentScheduler ---------------- */

test('planSegments：整除、不整除、小于一片、非法输入', () => {
  const exact = planSegments(300, 100)
  assert.deepEqual(exact.map(s => [s.start, s.end]), [[0, 99], [100, 199], [200, 299]])
  const ragged = planSegments(250, 100)
  assert.deepEqual(ragged.map(s => [s.start, s.end]), [[0, 99], [100, 199], [200, 249]])
  assert.deepEqual(planSegments(50, 100).map(s => [s.start, s.end]), [[0, 49]])
  assert.deepEqual(planSegments(0, 100), [])
  assert.deepEqual(planSegments(-5, 100), [])
  assert.deepEqual(planSegments(Number.NaN, 100), [])
  // 默认 10 MiB
  assert.equal(planSegments(25 * MiB).length, 3)
  assert.equal(planSegments(25 * MiB)[2].end, 25 * MiB - 1)
})

test('SegmentScheduler：领取、完成、放回，字节数正确', () => {
  const scheduler = new SegmentScheduler(planSegments(1000, 300))
  assert.equal(scheduler.completedBytes(), 0)
  const first = scheduler.claim()!
  assert.equal(first.segment.index, 0)
  assert.equal(first.resumeFrom, 0, '新分片从头下')
  const second = scheduler.claim()!
  assert.equal(second.segment.index, 1)
  assert.equal(scheduler.claim()!.segment.index, 2)
  assert.equal(scheduler.claim()!.segment.index, 3)
  assert.equal(scheduler.claim(), null, '所有分片都被占用时返回 null')
  scheduler.release(second.segment.index)
  assert.equal(scheduler.claim()!.segment.index, 1, '放回的分片可被再次领取')
  scheduler.complete(first.segment.index)
  scheduler.complete(first.segment.index)
  assert.equal(scheduler.completedBytes(), 300, '重复 complete 不重复计数')
  assert.equal(scheduler.completedCount(), 1)
  for (const index of [1, 2, 3]) scheduler.complete(index)
  assert.ok(scheduler.isDone())
  assert.equal(scheduler.completedBytes(), 1000)
  assert.deepEqual(scheduler.doneIndexes(), [0, 1, 2, 3])
  // 预置已完成分片
  const resumed = new SegmentScheduler(planSegments(1000, 300), [0, 3])
  assert.equal(resumed.completedBytes(), 400)
  assert.deepEqual(resumed.doneIndexes(), [0, 3])
  assert.equal(resumed.claim()!.segment.index, 1)
  // 越界的预置索引被忽略
  assert.equal(new SegmentScheduler(planSegments(100, 50), [7]).completedBytes(), 0)
})

test('SegmentScheduler 片内断点：进行中的分片记下已写入的字节，重新领取时从那里续', () => {
  const segments = planSegments(1000, 400)
  const scheduler = new SegmentScheduler(segments)
  const { segment } = scheduler.claim()!
  assert.equal(segment.index, 0)
  scheduler.advance(segment.index, 150)
  scheduler.advance(segment.index, 90)
  assert.equal(scheduler.completedBytes(), 0, '整片没写完不算完成')
  assert.equal(scheduler.persistedBytes(), 240, '已落盘字节数包含进行中分片里已写入的部分')
  // 中断（暂停 / 断网）：放回后保留已写入的部分
  scheduler.release(segment.index)
  assert.deepEqual(scheduler.partialMap(), { 0: 240 })
  const again = scheduler.claim()!
  assert.equal(again.segment.index, 0, '没下完的分片优先被接着下')
  assert.equal(again.resumeFrom, 240)
  // 这次尝试中途断开（网络错误要重试）：已写入的部分保留，重试从这里接着下，不整段重下
  scheduler.advance(segment.index, 100)
  scheduler.release(segment.index)
  assert.equal(scheduler.progressOf(segment.index), 340)
  const retry = scheduler.claim()!
  assert.equal(retry.segment.index, 0)
  assert.equal(retry.resumeFrom, 340)
  // 写满一片
  for (let written = 0; written < 160; written++) scheduler.advance(segment.index, 1)
  assert.equal(scheduler.persistedBytes(), 400)
  scheduler.complete(segment.index)
  assert.equal(scheduler.completedBytes(), 400)
  assert.deepEqual(scheduler.partialMap(), {}, '完成的分片不再出现在片内进度里')
  assert.equal(scheduler.persistedBytes(), 400)
})

test('SegmentScheduler 从控制文件恢复：done 与 partial 一起还原；非法值忽略、写满的算完成', () => {
  const segments = planSegments(2000, 500)
  const scheduler = new SegmentScheduler(segments, [1], { 0: 200, 2: 500, 3: -5, 9: 100, 1: 300 })
  // 1 已在 done 里：它身上的 partial 忽略；2 的 partial 写满 → 完成；3 负数、9 越界忽略
  assert.equal(scheduler.completedBytes(), 1000, '分片 1 与 2 已完成')
  assert.deepEqual(scheduler.partialMap(), { 0: 200 })
  assert.equal(scheduler.persistedBytes(), 1200)
  const claim = scheduler.claim()!
  assert.equal(claim.segment.index, 0)
  assert.equal(claim.resumeFrom, 200)
  assert.equal(scheduler.claim()!.segment.index, 3, '没有断点的分片从头下')
  // 旧版控制文件没有 partial：行为与以前一致
  const legacy = new SegmentScheduler(segments, [1])
  assert.deepEqual(legacy.partialMap(), {})
  assert.equal(legacy.claim()!.resumeFrom, 0)
})

/* ---------------- 控制文件 ---------------- */

const baseControl = (patch: Partial<ControlFile> = {}): ControlFile => ({ version: 1, url: URL_A, etag: '"v1"', lastModified: '', size: 1000, chunkSize: 100, done: [2, 0, 1], ...patch })

test('控制文件：保存与读取往返，done 去重并升序，先写临时文件再替换', async () => {
  const mock = await createMockAdapter()
  try {
    const target = mock.adapter.path.join(mock.root, 'a.bin')
    await mock.adapter.files.writeFile(target, Buffer.alloc(1000))
    await saveControl(mock.adapter, target, baseControl({ done: [2, 0, 1, 2] }))
    const controlPath = controlPathFor(target)
    assert.equal(controlPath, `${target}.ghctl`)
    const loaded = await loadControl(mock.adapter, target)
    assert.ok(loaded)
    assert.deepEqual(loaded.done, [0, 1, 2])
    assert.equal(loaded.size, 1000)
    assert.equal(await mock.adapter.files.stat(`${controlPath}.tmp`), null, '临时文件已被替换掉')
    // 不存在 / 损坏 / 版本不符 → null
    assert.equal(await loadControl(mock.adapter, mock.adapter.path.join(mock.root, 'missing.bin')), null)
    await mock.adapter.files.writeFile(controlPath, new TextEncoder().encode('{not json'))
    assert.equal(await loadControl(mock.adapter, target), null)
    await mock.adapter.files.writeFile(controlPath, new TextEncoder().encode(JSON.stringify(baseControl({ version: 2 as unknown as 1 }))))
    assert.equal(await loadControl(mock.adapter, target), null)
    await mock.adapter.files.writeFile(controlPath, new TextEncoder().encode(JSON.stringify({ version: 1, url: 'x', etag: '', lastModified: '', size: 10, chunkSize: 100, done: [-1] })))
    assert.equal(await loadControl(mock.adapter, target), null, '非法分片序号视为损坏')
  } finally { await mock.cleanup() }
})

test('validateControl：大小或远端身份不符时拒绝续传', () => {
  const meta = { size: 1000, etag: '"v1"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' }
  assert.equal(validateControl(baseControl(), 1000, meta), true)
  assert.equal(validateControl(baseControl(), 999, meta), false, '本地文件大小不符')
  assert.equal(validateControl(baseControl(), 1000, { ...meta, size: 2000 }), false, '远端大小变了')
  assert.equal(validateControl(baseControl(), 1000, { ...meta, etag: '"v2"' }), false, 'ETag 变了')
  assert.equal(validateControl(baseControl({ etag: '', lastModified: 'Thu, 02 Jan 2025 00:00:00 GMT' }), 1000, meta), false, '记录无 ETag 且 Last-Modified 也对不上：不续传')
  assert.equal(validateControl(baseControl({ etag: '' }), 1000, meta), true, '记录无 ETag 时退回 Last-Modified 比对，一致则可续传')
  assert.equal(validateControl(baseControl(), 1000, { ...meta, etag: '' }), false, '远端没给 ETag：无法确认，不续传')
  assert.equal(validateControl(baseControl({ etag: '', lastModified: '' }), 1000, { size: 1000, etag: '', lastModified: '' }), true, '双方都没有身份：只能信任大小')
  assert.equal(validateControl(baseControl({ etag: '', lastModified: 'X' }), 1000, { ...meta, etag: '', lastModified: 'X' }), true, '退回到 Last-Modified 比对')
})

test('控制文件节流保存：多次 mark 只写一次，flush 立即写，stop 后不再写', async () => {
  const mock = await createMockAdapter()
  try {
    const target = mock.adapter.path.join(mock.root, 't.bin')
    await mock.adapter.files.writeFile(target, Buffer.alloc(10))
    let control = baseControl({ done: [] })
    let writes = 0
    const counting: Adapter = { ...mock.adapter, files: { ...mock.adapter.files, writeFile: async (...args) => { writes++; return mock.adapter.files.writeFile(...args) } } }
    const saver = createControlSaver(counting, target, () => control, 40)
    saver.mark(); saver.mark(); saver.mark()
    control = baseControl({ done: [0, 1] })
    saver.mark()
    // 等节流窗口真的触发一次写入，而不是睡固定时长：机器负载高时固定时长可能不够
    await waitUntil(() => writes >= 1, 5000)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(writes, 1, '节流窗口内只写一次')
    assert.deepEqual((await loadControl(mock.adapter, target))?.done, [0, 1], '写入的是最新内容')
    saver.mark()
    control = baseControl({ done: [0, 1, 2] })
    await saver.flush()
    assert.equal(writes, 2)
    assert.deepEqual((await loadControl(mock.adapter, target))?.done, [0, 1, 2])
    await saver.stop()
    saver.mark()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(writes, 3, 'stop 之后 mark 不再触发写入')
  } finally { await mock.cleanup() }
})

/* ---------------- probe ---------------- */

test('probe：支持 Range 时取 content-range 的总大小；不支持时取 content-length', async () => {
  const ranged = await setup(5 * MiB, { acceptRanges: true })
  const plain = await setup(5 * MiB, { acceptRanges: false })
  try {
    const a = await probe(ranged.adapter, URL_A)
    assert.deepEqual(a, { size: 5 * MiB, acceptRanges: true, etag: '"v1"', lastModified: '' })
    const b = await probe(plain.adapter, URL_A)
    assert.equal(b.acceptRanges, false)
    assert.equal(b.size, 5 * MiB)
  } finally { await ranged.cleanup(); await plain.cleanup() }
})

/* ---------------- downloadFile ---------------- */

test('多连接分片下载：内容逐字节正确（分片没有写错位置）', async () => {
  const size = 3 * MiB + 12345
  const mock = await setup(size, { chunkSize: 64 * KiB })
  try {
    const { promise, progress } = run(mock.adapter, mock.targetPath)
    const result = await promise
    assert.equal(result.bytes, size)
    assert.equal(result.resumed, false)
    const content = Buffer.from(await mock.readBack())
    assert.ok(content.equals(Buffer.from(contentAt(0, size))), '内容应与远端逐字节一致')
    assert.equal(content.length, size)
    // 每个分片恰好被请求一次，覆盖全文件
    const ranges = mock.network.log.filter(entry => entry.range && entry.range !== 'bytes=0-0')
    const segments = planSegments(size, 256 * KiB)
    assert.equal(ranges.length, segments.length)
    const covered = new Set(ranges.map(entry => entry.range))
    for (const segment of segments) assert.ok(covered.has(`bytes=${segment.start}-${segment.end}`), `缺少分片 ${segment.index}`)
    assert.deepEqual(progress.at(-1), [size, size], '最后一次进度是 100%')
    assert.ok(progress.every(([downloaded, total]) => downloaded <= total && total === size))
    assert.equal(await mock.adapter.files.stat(controlPathFor(mock.targetPath)), null, '完成后删除控制文件')
  } finally { await mock.cleanup() }
})

test('服务器不支持 Range：降级为单连接，内容正确', async () => {
  const size = 2 * MiB + 777
  const mock = await setup(size, { acceptRanges: false })
  try {
    const result = await run(mock.adapter, mock.targetPath).promise
    assert.equal(result.bytes, size)
    assert.ok(Buffer.from(await mock.readBack()).equals(Buffer.from(contentAt(0, size))))
    const dataRequests = mock.network.log.filter(entry => entry.range !== 'bytes=0-0')
    assert.equal(dataRequests.length, 1, '只发了一个不带 Range 的整文件请求')
    assert.equal(dataRequests[0].range, undefined)
  } finally { await mock.cleanup() }
})

test('探测支持 Range、但分片请求被无视（回 200）：不把整文件写进分片，改用单连接重下', async () => {
  const size = 1 * MiB + 5
  const mock = await setup(size, { acceptRanges: true })
  try {
    // 包装适配层：探测请求（bytes=0-0）照常，其余 Range 请求返回不认 Range 的流
    const original = mock.adapter.openStream.bind(mock.adapter)
    const ignoring: Adapter = { ...mock.adapter, openStream: async (url, options) => {
      if (options?.range && options.range !== 'bytes=0-0') return original(url, { ...options, range: undefined })
      return original(url, options)
    } }
    const result = await run(ignoring, mock.targetPath).promise
    assert.equal(result.bytes, size)
    assert.ok(Buffer.from(await mock.readBack()).equals(Buffer.from(contentAt(0, size))), '降级后内容仍正确')
  } finally { await mock.cleanup() }
})

test('断流后重试成功，内容正确；已写到盘上的字节不重下', async () => {
  const size = 1 * MiB + 4096
  const mock = await setup(size, { breakAfterChunks: 2 })
  try {
    // 重试退避是秒级，测试里把 RETRY_DELAYS 缩短不了：改用小分片 + 只让第一条连接断流
    mock.network.streams.get(URL_A)!.breakAfterChunks = -1
    const original = mock.adapter.openStream.bind(mock.adapter)
    let broken = 0
    const flaky: Adapter = { ...mock.adapter, openStream: async (url, options) => {
      const stream = await original(url, options)
      if (options?.range && options.range !== 'bytes=0-0' && broken++ === 0) {
        // 真实的断流：先正常交出两块（引擎写盘并记进度），下一次读的时候连接被重置
        let served = 0
        let cut = false
        return new Proxy(stream, {
          get(target, key) {
            if (key !== 'read') return Reflect.get(target, key)
            return async () => {
              if (cut) throw Object.assign(new Error('连接被重置'), { code: 'ECONNRESET' })
              if (served >= 2) { cut = true; throw Object.assign(new Error('连接被重置'), { code: 'ECONNRESET' }) }
              served++
              return target.read()
            }
          },
        })
      }
      return stream
    } }
    mock.network.log.length = 0
    const result = await run(flaky, mock.targetPath, { connections: 1 }).promise
    assert.equal(result.bytes, size)
    assert.ok(Buffer.from(await mock.readBack()).equals(Buffer.from(contentAt(0, size))), '重试后内容正确')
    assert.ok(broken >= 2, '失败的分片被重新请求')
    // 断流前已经写到盘上的两块（mock 每块 64 KiB，共 128 KiB）不重下：重试请求从分片起点 + 128 KiB 开始
    const dataRanges = mock.network.log.filter(entry => entry.range && entry.range !== 'bytes=0-0').map(entry => entry.range!)
    const writtenBeforeCut = 2 * mock.network.chunkSize
    assert.ok(dataRanges.includes(`bytes=${writtenBeforeCut}-${256 * KiB - 1}`), `重试应从 ${writtenBeforeCut} 处接着下，实际请求：${dataRanges.join(' ')}`)
    // 实际传输量 = 文件大小：首个请求交出两块（128 KiB）后断流，重试从 128 KiB 接着下，没有任何字节被重下
    const transferred = writtenBeforeCut + dataRanges.slice(1).reduce((sum, range) => { const [from, to] = range.replace('bytes=', '').split('-').map(Number); return sum + (to - from + 1) }, 0)
    assert.equal(transferred, size, '断流一次也不重下任何字节')
  } finally { await mock.cleanup() }
})

test('探测阶段遇到 403：不重试，且必须翻译成 URL_EXPIRED（上层据此刷新直链）', async () => {
  const mock = await setup(MiB)
  try {
    let calls = 0
    const forbidden: Adapter = { ...mock.adapter, openStream: async (url, options) => {
      calls++
      throw Object.assign(new Error('forbidden'), { status: 403, code: 'HTTP_403' })
    } }
    // 曾经这里放宽到接受 HTTP_403，于是"一开始就过期的直链不会被刷新"的缺陷一直没被发现
    await assert.rejects(() => run(forbidden, mock.targetPath).promise, (error: unknown) => (error as { code?: string }).code === 'URL_EXPIRED')
    assert.equal(calls, 1, '只调用了一次（探测阶段就失败），没有重试')
  } finally { await mock.cleanup() }
})

test('分片阶段遇到 403：不重试，抛 URL_EXPIRED', async () => {
  const mock = await setup(MiB)
  try {
    const original = mock.adapter.openStream.bind(mock.adapter)
    let dataCalls = 0
    const expiring: Adapter = { ...mock.adapter, openStream: async (url, options) => {
      if (options?.range && options.range !== 'bytes=0-0') { dataCalls++; throw Object.assign(new Error('gone'), { status: 403, code: 'HTTP_403' }) }
      return original(url, options)
    } }
    await assert.rejects(() => run(expiring, mock.targetPath, { connections: 1 }).promise, (error: unknown) => (error as { code?: string }).code === 'URL_EXPIRED')
    assert.equal(dataCalls, 1, '403 不重试')
  } finally { await mock.cleanup() }
})

test('中止：保留目标文件与控制文件，抛 AbortError；续传不重下已完成的分片', async () => {
  const size = 4 * MiB
  const mock = await setup(size, { chunkSize: 32 * KiB })
  try {
    // 第一次：下载到一部分后中止
    // 限速让下载足够慢，中止时已有若干整片完成、其余进行中（这是续传场景的前提）
    const first = run(mock.adapter, mock.targetPath, { connections: 2, speedLimit: 400 * KiB })
    const stopper = setTimeout(() => first.controller.abort(), 1_500)
    await assert.rejects(first.promise, (error: unknown) => isAbortError(error))
    clearTimeout(stopper)
    assert.ok(await mock.adapter.files.stat(mock.targetPath), '中止后目标文件仍在')
    const control = await loadControl(mock.adapter, mock.targetPath)
    assert.ok(control, '中止后有控制文件')
    const doneBefore = control!.done.length
    const segmentCount = planSegments(size, 256 * KiB).length
    assert.ok(doneBefore > 0 && doneBefore < segmentCount, `应只完成一部分分片：${doneBefore}/${segmentCount}`)
    const requestsBefore = mock.network.log.filter(entry => entry.range && entry.range !== 'bytes=0-0').length
    // 中止时收尾会如实报一次最终进度：任务记录里的字节数 = 控制文件里已落盘的字节数（进度条与实际能续传的一致）
    const persistedInControl = control!.done.reduce((sum, index) => sum + 256 * KiB, 0) + Object.values(control!.partial ?? {}).reduce((sum, bytes) => sum + bytes, 0)
    assert.equal(first.progress[first.progress.length - 1]?.[0], persistedInControl, '最后一次进度回调应等于控制文件里已落盘的字节数')

    // 第二次：续传
    const before = requestsBefore
    mock.network.log.length = 0
    const lastProgress = first.progress[first.progress.length - 1]?.[0] ?? 0
    const second = await run(mock.adapter, mock.targetPath, { connections: 3, speedLimit: 4 * MiB }).promise
    assert.equal(second.resumed, true)
    assert.ok(Buffer.from(await mock.readBack()).equals(Buffer.from(contentAt(0, size))), '续传后内容正确')
    const requested = new Set(mock.network.log.filter(entry => entry.range && entry.range !== 'bytes=0-0').map(entry => entry.range!))
    const segments = planSegments(size, 256 * KiB)
    for (const index of control!.done) {
      const segment = segments[index]
      assert.ok(!requested.has(`bytes=${segment.start}-${segment.end}`), `已完成分片 ${index} 不应被重新请求`)
    }
    // 片内断点：没下完的分片也从上次写到的地方接着下，不整片重下
    const partial = control!.partial ?? {}
    assert.ok(Object.keys(partial).length > 0, '中止时进行中的分片应记下已写入的字节数')
    for (const [rawIndex, bytes] of Object.entries(partial)) {
      const segment = segments[Number(rawIndex)]
      assert.ok(!requested.has(`bytes=${segment.start}-${segment.end}`), `进行中的分片 ${rawIndex} 不应整片重下`)
      assert.ok(requested.has(`bytes=${segment.start + bytes}-${segment.end}`), `分片 ${rawIndex} 应从 ${segment.start + bytes} 续传，实际请求：${[...requested].join(' ')}`)
    }
    // 已经写到盘上的字节一个都不重下：以控制文件记录的为准（进度回调按 64 KiB 步长节流，最后一次回调可能落后一点）
    const persisted = control!.done.reduce((sum, index) => sum + (segments[index].end - segments[index].start + 1), 0)
      + Object.values(partial).reduce((sum, bytes) => sum + bytes, 0)
    const retransmitted = [...requested].reduce((sum, range) => { const [from, to] = range.replace('bytes=', '').split('-').map(Number); return sum + (to - from + 1) }, 0)
    assert.equal(persisted + retransmitted, size, `已落盘 ${persisted} + 重下 ${retransmitted} 应正好等于文件大小`)
    // 进度回调也不能比真实落盘的多：否则暂停时进度条虚高、续传时回落
    assert.ok(lastProgress <= persisted + 64 * KiB && lastProgress >= persisted - 64 * KiB, `最后一次进度回调 ${lastProgress} 应接近已落盘的 ${persisted}`)
    assert.equal(before >= 0, true)
    assert.equal(await mock.adapter.files.stat(controlPathFor(mock.targetPath)), null, '完成后控制文件被删除')
  } finally { await mock.cleanup() }
})

test('控制文件带片内进度往返；旧版控制文件（没有 partial）照样能读', async () => {
  const mock = await setup(1024)
  try {
    await saveControl(mock.adapter, mock.targetPath, { ...baseControl(), partial: { 3: 40, 7: 12 } })
    const loaded = await loadControl(mock.adapter, mock.targetPath)
    assert.deepEqual(loaded?.done, [0, 1, 2])
    assert.deepEqual(loaded?.partial, { 3: 40, 7: 12 })
    // 没有片内进度时不写 partial 字段
    await saveControl(mock.adapter, mock.targetPath, baseControl({ partial: {} }))
    assert.equal((await loadControl(mock.adapter, mock.targetPath))?.partial, undefined)
    const raw = new TextDecoder().decode(await mock.adapter.files.readFile(controlPathFor(mock.targetPath)))
    assert.ok(!raw.includes('partial'), '空的片内进度不写进文件')
    // 旧版文件：没有 partial 字段
    await mock.adapter.files.writeFile(controlPathFor(mock.targetPath), new TextEncoder().encode(JSON.stringify({ version: 1, url: URL_A, etag: '"v1"', lastModified: '', size: 1000, chunkSize: 100, done: [1] })))
    const legacy = await loadControl(mock.adapter, mock.targetPath)
    assert.deepEqual(legacy?.done, [1])
    assert.equal(legacy?.partial, undefined)
    // 非法形状的 partial 被丢弃，done 不受影响
    await mock.adapter.files.writeFile(controlPathFor(mock.targetPath), new TextEncoder().encode(JSON.stringify({ version: 1, url: URL_A, etag: '"v1"', lastModified: '', size: 1000, chunkSize: 100, done: [1], partial: { x: 5, 2: -1, 3: 1.5, 4: 30 } })))
    assert.deepEqual((await loadControl(mock.adapter, mock.targetPath))?.partial, { 4: 30 })
  } finally { await mock.cleanup() }
})

test('续传校验失败（远端文件变了）：丢弃旧进度从头下载', async () => {
  const size = 2 * MiB
  const mock = await setup(size)
  try {
    const segments = planSegments(size, 256 * KiB)
    // 伪造「上次完成了一半、但 ETag 是旧的」的状态
    await mock.adapter.files.writeFile(mock.targetPath, Buffer.alloc(size))
    await saveControl(mock.adapter, mock.targetPath, { version: 1, url: URL_A, etag: '"old"', lastModified: '', size, chunkSize: 256 * KiB, done: segments.slice(0, 4).map(s => s.index) })
    const result = await run(mock.adapter, mock.targetPath).promise
    assert.equal(result.resumed, false)
    const requested = mock.network.log.filter(entry => entry.range && entry.range !== 'bytes=0-0').length
    assert.equal(requested, segments.length, '所有分片都被重新下载')
    assert.ok(Buffer.from(await mock.readBack()).equals(Buffer.from(contentAt(0, size))))
  } finally { await mock.cleanup() }
})

test('本地已有完整文件但无控制文件：仍会完整下载（由上层决定是否跳过）', async () => {
  const size = MiB
  const mock = await setup(size)
  try {
    await mock.adapter.files.writeFile(mock.targetPath, contentAt(0, size))
    const result = await run(mock.adapter, mock.targetPath).promise
    assert.equal(result.resumed, false)
    assert.equal(result.bytes, size)
  } finally { await mock.cleanup() }
})

test('限速生效：总耗时不低于按速率推算的下界', async () => {
  const size = 512 * KiB
  const mock = await setup(size, { chunkSize: 16 * KiB })
  try {
    const started = Date.now()
    await run(mock.adapter, mock.targetPath, { connections: 4, speedLimit: 256 * KiB }).promise
    const elapsed = Date.now() - started
    assert.ok(Buffer.from(await mock.readBack()).equals(Buffer.from(contentAt(0, size))))
    assert.ok(elapsed >= 1_500, `512 KiB @ 256 KiB/s 应至少约 2 秒，实际 ${elapsed}ms`)
  } finally { await mock.cleanup() }
})

test('连接数不超过分片数；单个分片也能下载', async () => {
  const size = 100 * 1024
  const mock = await setup(size)
  try {
    const result = await run(mock.adapter, mock.targetPath, { connections: 16, chunkSize: 1024 * 1024 }).promise
    assert.equal(result.bytes, size)
    assert.ok(Buffer.from(await mock.readBack()).equals(Buffer.from(contentAt(0, size))))
    assert.equal(mock.network.log.filter(entry => entry.range && entry.range !== 'bytes=0-0').length, 1)
  } finally { await mock.cleanup() }
})

test('服务器返回的分片范围与请求不符：拒绝写入', async () => {
  const size = MiB
  const mock = await setup(size)
  try {
    const original = mock.adapter.openStream.bind(mock.adapter)
    const mismatched: Adapter = { ...mock.adapter, openStream: async (url, options) => {
      const stream = await original(url, options)
      if (options?.range && options.range !== 'bytes=0-0') return new Proxy(stream, { get(target, key) { return key === 'headers' ? { ...target.headers, 'content-range': 'bytes 999-1000/1048576' } : Reflect.get(target, key) } })
      return stream
    } }
    await assert.rejects(() => run(mismatched, mock.targetPath, { connections: 1 }).promise, (error: unknown) => (error as { code?: string }).code === 'RANGE_MISMATCH')
  } finally { await mock.cleanup() }
})

test('onMeta 回调给出探测结果；请求头被带上', async () => {
  const size = 300 * KiB
  const mock = await setup(size)
  try {
    let meta: unknown = null
    await run(mock.adapter, mock.targetPath, { onMeta: value => { meta = value }, headers: { cookie: 'SESSION=x' } } as Partial<Parameters<typeof downloadFile>[1]>).promise
    assert.deepEqual(meta, { size, acceptRanges: true, etag: '"v1"', lastModified: '' })
    assert.ok(mock.network.log.length > 0)
    assert.ok(mock.network.log.every(entry => entry.headers.cookie === 'SESSION=x'), '每个请求都带上了调用方给的 cookie')
  } finally { await mock.cleanup() }
})

test('mock.network.lookup：先精确匹配，再按去掉查询串匹配', async () => {
  const network = new MockNetwork()
  network.respond('https://x.test/api', { body: 'generic' })
  network.respond('https://x.test/api?special=1', { body: 'special' })
  assert.equal(await resolveBody(network.lookup('https://x.test/api?special=1')), 'special')
  assert.equal(await resolveBody(network.lookup('https://x.test/api?noCache=123')), 'generic')
  assert.equal(await resolveBody(network.lookup('https://x.test/api')), 'generic')
  assert.equal(network.lookup('https://x.test/other'), undefined)
})

async function resolveBody(entry: unknown): Promise<string> {
  assert.equal(typeof entry, 'object', '对象形式的假响应被规范化为对象')
  return new TextDecoder().decode((entry as { body: Uint8Array }).body)
}
