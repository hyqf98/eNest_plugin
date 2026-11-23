import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMockAdapter } from '../../backend/adapters/mock.ts'
import { createLiveAdapter, setPackagePath } from '../../backend/adapters/live.ts'

// 测试文件位于 <插件根>/tests/backend/，缓存位于 <插件根>/vendor-cache/
const VENDOR = join(import.meta.dirname, '..', '..', 'vendor-cache', 'win32-x64')
const SEVEN_ZIP = join(VENDOR, '7z.exe')

/** live 适配层在 runtime/7zip/<target>/ 下找 7z；测试里在临时目录摆出同样结构后返回其 archive 接口 */
async function liveArchive() {
  const { copyFile, mkdir, mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const pkg = await mkdtemp(join(tmpdir(), 'gh-7z-pkg-'))
  const target = join(pkg, 'runtime', '7zip', 'win32-x64')
  await mkdir(target, { recursive: true })
  await copyFile(join(VENDOR, '7z.exe'), join(target, '7z.exe'))
  await copyFile(join(VENDOR, '7z.dll'), join(target, '7z.dll'))
  setPackagePath(pkg)
  const { archive } = createLiveAdapter()
  return { extract: archive.extract, cleanup: () => import('node:fs/promises').then(fs => fs.rm(pkg, { recursive: true, force: true })) }
}

/** 逐块拼接后内容必须与按顺序直接相连完全一致 */
test('concatFiles 按顺序拼接多个文件，内容逐字节一致', async () => {
  const { adapter, root, cleanup } = await createMockAdapter()
  try {
    const a = Buffer.alloc(300_000); for (let i = 0; i < a.length; i++) a[i] = i % 251
    const b = Buffer.alloc(123_457); for (let i = 0; i < b.length; i++) b[i] = (i * 3) % 251
    const c = Buffer.alloc(1)
    await adapter.files.writeFile(join(root, 'a.bin'), a)
    await adapter.files.writeFile(join(root, 'b.bin'), b)
    await adapter.files.writeFile(join(root, 'c.bin'), c)
    let lastProgress: [number, number] = [0, 0]
    await adapter.files.concatFiles([join(root, 'a.bin'), join(root, 'b.bin'), join(root, 'c.bin')], join(root, 'out', 'joined.bin'), undefined, (copied, total) => { lastProgress = [copied, total] })
    const joined = Buffer.from(await adapter.files.readFile(join(root, 'out', 'joined.bin')))
    assert.ok(joined.equals(Buffer.concat([a, b, c])))
    assert.deepEqual(lastProgress, [a.length + b.length + c.length, a.length + b.length + c.length])
  } finally { await cleanup() }
})

test('concatFiles 覆盖已存在的目标；中止信号抛 AbortError', async () => {
  const { adapter, root, cleanup } = await createMockAdapter()
  try {
    await adapter.files.writeFile(join(root, 'a.bin'), Buffer.from('AAAA'))
    await adapter.files.writeFile(join(root, 'target.bin'), Buffer.from('OLD-CONTENT-LONGER-THAN-NEW'))
    await adapter.files.concatFiles([join(root, 'a.bin')], join(root, 'target.bin'))
    assert.equal(Buffer.from(await adapter.files.readFile(join(root, 'target.bin'))).toString(), 'AAAA')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => adapter.files.concatFiles([join(root, 'a.bin')], join(root, 'aborted.bin'), controller.signal),
      (error: unknown) => (error as Error).name === 'AbortError',
    )
  } finally { await cleanup() }
})

/**
 * 真实场景：WinZip 风格的 .zip + .z01 分卷（数据顺序切分，.zip 存末段与中央目录）。
 * 用真实的 7-Zip 验证两条路径都能解出正确内容：
 *   1. 续卷齐全时直接解主卷；
 *   2. 用 concatFiles 按序拼接成完整 zip 后再解（续卷不齐、或 7z 认不出分卷时的回退）。
 * 没有 vendor-cache 里的 7z.exe 时跳过而不是失败。
 */
test('WinZip 分卷：直接解主卷与拼接后解压都能得到正确内容', async (t) => {
  try { await readFile(SEVEN_ZIP) } catch { t.skip('vendor-cache 里没有 7z.exe（先运行 npm run vendor）'); return }
  const { adapter, root, cleanup } = await createMockAdapter()
  try {
    const src = join(root, 'src'); await mkdir(src, { recursive: true })
    // 随机字节不可压缩，保证归档远大于切分点、续卷里真的有数据
    const original = randomBytes(400_000)
    await adapter.files.writeFile(join(src, 'data.bin'), original)
    const whole = join(root, 'whole.zip')
    await run7z(['a', '-tzip', whole, 'data.bin'], src)
    const archive = Buffer.from(await adapter.files.readFile(whole))
    assert.ok(archive.length > 300_000, `归档应接近原始大小（不可压缩），实际 ${archive.length}`)
    const cut = Math.floor(archive.length / 2)
    const gameDir = join(root, 'Game v1.0'); await mkdir(gameDir, { recursive: true })
    await adapter.files.writeFile(join(gameDir, 'Game.z01'), archive.subarray(0, cut))
    await adapter.files.writeFile(join(gameDir, 'Game.zip'), archive.subarray(cut))

    // 1) 续卷齐全时直接解主卷：实测 7-Zip 打不开按字节顺序切分的 .zip 末卷（Is not archive）。
    //    这正是需要下面回退拼接的原因；断言它确实失败，避免以后样本失效却没人发现。
    const directDir = join(root, 'direct')
    await adapter.files.ensureDir(directDir)
    const direct = await extract(join(gameDir, 'Game.zip'), directDir)
    assert.notEqual(direct.code, 0, `直接解末卷应当失败（样本或 7z 行为变了），实际 exit=${direct.code}：${direct.tail}`)

    // 2) 回退：按 .z01 → .zip 顺序拼接成完整 zip 再解
    const joined = join(gameDir, 'Game.joined.zip')
    await adapter.files.concatFiles([join(gameDir, 'Game.z01'), join(gameDir, 'Game.zip')], joined)
    assert.ok(Buffer.from(await adapter.files.readFile(joined)).equals(archive), '拼接结果应与原始完整 zip 完全一致')
    const fallbackDir = join(root, 'fallback')
    await adapter.files.ensureDir(fallbackDir)
    const live = await liveArchive()
    try {
      const fallbackResult = await live.extract({ archive: joined, outputDir: fallbackDir })
    assert.equal(fallbackResult.exitCode, 0, `拼接后解压应成功，实际 exit=${fallbackResult.exitCode}：${fallbackResult.tail}`)
      assert.ok(Buffer.from(await adapter.files.readFile(join(fallbackDir, 'data.bin'))).equals(original), '拼接后解出的内容应与原始数据一致')
    } finally { await live.cleanup() }

    // 3) 续卷缺失：只拿末卷去拼接也解不出完整数据（不能把残缺的包当成安装成功）
    const lonelyDir = join(root, 'lonely'); await mkdir(lonelyDir, { recursive: true })
    await adapter.files.writeFile(join(lonelyDir, 'Game.zip'), archive.subarray(cut))
    const lonelyOut = join(root, 'lonely-out'); await adapter.files.ensureDir(lonelyOut)
    const missing = await extract(join(lonelyDir, 'Game.zip'), lonelyOut)
    assert.notEqual(missing.code, 0, '缺少续卷时不应报告成功')
  } finally { await cleanup() }
})

function run7z(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(SEVEN_ZIP, [...args, '-bso0', '-bsp0'], { cwd, windowsHide: true }, error => error ? reject(new Error(`7z ${args[0]} 失败：${error.message}`)) : resolve())
  })
}

/** 运行 7z x 并返回退出码与输出末尾；7z 打不开归档时返回非 0 而不是抛错 */
function extract(archive: string, outputDir: string): Promise<{ code: number; tail: string }> {
  return new Promise((resolve, reject) => {
    execFile(SEVEN_ZIP, ['x', archive, `-o${outputDir}`, '-y', '-bso0', '-bsp0'], { windowsHide: true }, (error, _stdout, stderr) => {
      const code = (error as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code
      if (error && typeof code !== 'number') { reject(new Error(String(stderr || error.message).slice(0, 200))); return }
      resolve({ code: typeof code === 'number' ? code : 0, tail: String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-1).join('') })
    })
  })
}
