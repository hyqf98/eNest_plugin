/**
 * 纯逻辑测试（node --test）：
 * sprite 参数计算 / hash 选行 / normalizePet / 计数格式 / 安装命令 /
 * 宠物包校验（fflate zipSync 构造 fixture）/ webp 尺寸探测。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { decodeBase64Chunks } from '../src/js/netbin.js'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))

// esbuild 打平 src/js 模块（fflate 从 node_modules 解析）
let api
{
  const entry = `${pluginRoot}tests/.entry.tmp.mjs`
  writeFileSync(entry, `
    export * from '${pluginRoot}src/js/config.js'
    export * from '${pluginRoot}src/js/api.js'
    export * from '${pluginRoot}src/js/installer.js'
  `)
  const built = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node' })
  const tmp = `${pluginRoot}tests/.bundle.tmp.mjs`
  writeFileSync(tmp, built.outputFiles[0].text)
  api = await import(tmp)
}

const { pickGalleryPetState, lookDirectionCell, spriteDurationMs, petAnimationRows, FILTER_TAGS,
  normalizePet, formatCount, petImportCommand, validatePetPackage, webpSize, installTargets } = api

// —— sprite 参数 ——

test('pickGalleryPetState: 与原站一致的确定性 hash 选行', () => {
  const a = pickGalleryPetState('bedro')
  const b = pickGalleryPetState('bedro')
  assert.equal(a.id, b.id)
  assert.ok(['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'].includes(a.id))
  // 手工复核原站公式：hash = (hash*31 + code)|0
  let hash = 0
  for (let i = 0; i < 'bedro'.length; i += 1) hash = (hash * 31 + 'bedro'.charCodeAt(i)) | 0
  const rows = petAnimationRows(2)
  assert.equal(a.id, rows[Math.abs(hash) % 9].id)
})

test('spriteDurationMs: max(帧数×260, 1400)', () => {
  assert.equal(spriteDurationMs(4), 1400)
  assert.equal(spriteDurationMs(6), 1560)
  assert.equal(spriteDurationMs(8), 2080)
})

test('lookDirectionCell: 16 方向环形 + row 9/10 映射', () => {
  assert.deepEqual({ row: lookDirectionCell(0).row, frame: lookDirectionCell(0).frame }, { row: 9, frame: 0 })
  assert.equal(lookDirectionCell(7).frame, 7)
  assert.equal(lookDirectionCell(8).row, 10)
  assert.equal(lookDirectionCell(8).frame, 0)
  assert.equal(lookDirectionCell(-1).frame, 7) // 负数环形归一
  assert.equal(lookDirectionCell(16).row, 9) // 超界环形归一
})

test('petAnimationRows: v1 九行 / v2 十一行；FILTER_TAGS 为 18 个且不含 kind', () => {
  assert.equal(petAnimationRows(1).length, 9)
  assert.equal(petAnimationRows(2).length, 11)
  assert.equal(FILTER_TAGS.length, 18)
  for (const kind of ['object', 'animal', 'person', 'creature']) {
    assert.ok(!FILTER_TAGS.includes(kind))
  }
})

// —— API 归一化 ——

test('normalizePet: 版本推断（显式 > report > atlas 尺寸）与 URL 绝对化', () => {
  const explicit = normalizePet({ id: 'x', spriteVersionNumber: 1, tags: null, viewCount: 0 })
  assert.equal(explicit.spriteVersionNumber, 1)
  const byReport = normalizePet({ id: 'x', validationReport: { spriteVersionNumber: 2 } })
  assert.equal(byReport.spriteVersionNumber, 2)
  const byAtlas = normalizePet({ id: 'x', validationReport: { atlasSize: '1536x2288' } })
  assert.equal(byAtlas.spriteVersionNumber, 2)
  const byAtlasV1 = normalizePet({ id: 'x', validationReport: { atlasSize: '1536x1872' } })
  assert.equal(byAtlasV1.spriteVersionNumber, 1)
  assert.equal(normalizePet({ id: 'x', downloadUrl: '/api/pets/x/download?v=1' }).downloadUrl,
    'https://codex-pets.net/api/pets/x/download?v=1')
  assert.deepEqual(normalizePet({ id: 'x' }).tags, [])
})

test('formatCount: 13.2K / 1M 风格', () => {
  assert.equal(formatCount(999), '999')
  assert.equal(formatCount(1000), '1K')
  assert.equal(formatCount(13200), '13.2K')
  assert.equal(formatCount(2100000), '2.1M')
})

test('petImportCommand: CLI 与 curl 两种模式（对齐原站）', () => {
  const pet = { id: 'bedro', downloadUrl: 'https://codex-pets.net/api/pets/bedro/download?v=1' }
  assert.equal(petImportCommand(pet, 'cli'), 'npx codex-pets add bedro')
  const curl = petImportCommand(pet, 'curl')
  assert.ok(curl.includes('curl -L "https://codex-pets.net/api/pets/bedro/download?v=1"'))
  assert.ok(curl.includes('mkdir -p "$HOME/.codex/pets/bedro"'))
  assert.ok(curl.includes('unzip -o "/tmp/bedro.codex-pet.zip"'))
})

// —— 宠物包校验 ——

function fakeWebpV2() {
  // VP8X 头：RIFF....WEBPVP8X + flags/_reserved 10 字节 + 24bit canvas w-1/h-1（1535 / 2287）
  const bytes = new Uint8Array(30)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X
  const w = 1536 - 1, h = 2288 - 1
  bytes[24] = w & 0xff; bytes[25] = (w >> 8) & 0xff; bytes[26] = (w >> 16) & 0xff
  bytes[27] = h & 0xff; bytes[28] = (h >> 8) & 0xff; bytes[29] = (h >> 16) & 0xff
  return bytes
}

test('webpSize: VP8X 头解析 1536×2288', () => {
  assert.deepEqual(webpSize(fakeWebpV2()), { width: 1536, height: 2288 })
  assert.equal(webpSize(new Uint8Array(10)), null)
})

test('validatePetPackage: 合法 v2 包解出 manifest 与 sprite 字节', () => {
  const zip = zipSync({
    'pet.json': strToU8(JSON.stringify({ id: 'bedro', displayName: '베드로', kind: 'object', spriteVersionNumber: 2 })),
    'spritesheet.webp': fakeWebpV2()
  })
  const pkg = validatePetPackage(zip, 'bedro')
  assert.equal(pkg.id, 'bedro')
  assert.equal(pkg.version, 2)
  assert.equal(pkg.sheetBytes.length, 30)
  assert.equal(pkg.manifest.displayName, '베드로')
})

test('validatePetPackage: 嵌套目录 / 缺文件 / 坏 JSON / 尺寸不匹配全部拒绝', () => {
  assert.doesNotThrow(() => validatePetPackage(zipSync({
    'pkg/pet.json': strToU8(JSON.stringify({ id: 'x', displayName: 'X', spriteVersionNumber: 2 })),
    'pkg/spritesheet.webp': fakeWebpV2()
  }), 'x'))
  assert.throws(() => validatePetPackage(zipSync({ 'pet.json': strToU8('{}') })), /spritesheet/)
  assert.throws(() => validatePetPackage(zipSync({ 'spritesheet.webp': fakeWebpV2() })), /pet\.json/)
  assert.throws(() => validatePetPackage(zipSync({
    'pet.json': strToU8('{bad json'),
    'spritesheet.webp': fakeWebpV2()
  })), /JSON/)
  assert.throws(() => validatePetPackage(zipSync({
    'pet.json': strToU8(JSON.stringify({ id: 'x', displayName: 'X', spriteVersionNumber: 1 })), // v1 声明但 v2 图
    'spritesheet.webp': fakeWebpV2()
  })), /高度/)
  assert.throws(() => validatePetPackage(new Uint8Array([1, 2, 3])), /zip/)
  assert.throws(() => validatePetPackage(zipSync({
    'pet.json': strToU8(JSON.stringify({ kind: 'object' })),
    'spritesheet.webp': fakeWebpV2()
  })), /缺少 id/)
})

test('installTargets: pets/<id>/ 两文件', () => {
  assert.deepEqual(installTargets('bedro'), ['pets/bedro/pet.json', 'pets/bedro/spritesheet.webp'])
})

// 构建产物清理（.entry.tmp.mjs / .bundle.tmp.mjs 为运行期临时文件）
test.after?.(() => {}) // noop 保持结构清晰
process.on('exit', () => {
  for (const f of ['.entry.tmp.mjs', '.bundle.tmp.mjs']) {
    try { rmSync(`${pluginRoot}tests/${f}`, { force: true }) } catch { /* 忽略 */ }
  }
})

// —— 流式二进制解码（宿主按任意边界分片独立编码） ——

test('decodeBase64Chunks: 任意边界分片（含中间片 padding）逐片解码拼接正确', () => {
  const bytes = new Uint8Array(1000)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251
  const b64 = Buffer.from(bytes).toString('base64')
  // 模拟宿主按 7 字节块独立编码（7 % 3 != 0，中间片必带 padding）
  const chunks = []
  for (let i = 0; i < bytes.length; i += 7) {
    chunks.push(Buffer.from(bytes.subarray(i, Math.min(i + 7, bytes.length))).toString('base64'))
  }
  assert.notEqual(chunks.join(''), b64) // join 后必然与整体编码不同（验证用例有效性）
  const decoded = decodeBase64Chunks(chunks)
  assert.equal(decoded.length, bytes.length)
  assert.deepEqual(Buffer.from(decoded), Buffer.from(bytes))
  // 与整体编码对照
  assert.deepEqual(Buffer.from(decodeBase64Chunks([b64])), Buffer.from(bytes))
  // 脏字符报解码失败
  assert.throws(() => decodeBase64Chunks(['@@@']), /解码失败/)
})
