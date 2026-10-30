/**
 * installer — Codex 宠物安装器（插件私有 Node 后端）。
 * 流程：检测 → 下载 .codex-pet.zip（netbin 流式）→ fflate 解压
 * → 校验（pet.json 可解析 + atlas 尺寸与 spriteVersionNumber 匹配）→
 * 分块传给插件后端，通用宿主原生确认后写入 ~/.codex/pets/<id>/ 并保存覆盖快照。
 * 纯校验函数（validatePetPackage / installTargets）供 tests/ 覆盖。
 */
import { unzipSync } from 'fflate'
import { downloadBinary, toBase64 } from './netbin.js'

export const CODEX_APP = 'codex'

async function backendCall(method, input) {
  const api = (window.enest || window.zapi)?.backend
  if (typeof api?.call !== 'function') throw new Error('请使用 eNest 0.0.1 或更新版本并授权本机 Node 后端')
  return api.call(method, input === undefined ? [] : [input])
}

export async function listInstalledAssets() {
  return backendCall('assets.list', { app: CODEX_APP, path: 'pets' })
}

/** Each transport message stays below 4 MiB without lowering the 8 MiB file limit. */
export async function writeAssetChunks(assets) {
  if (assets.some(asset => !asset.bytes.length || asset.bytes.length > 8 * 1024 * 1024)) throw new Error('宠物单文件大小须为 1 字节至 8 MiB')
  const { stageId, chunkBytes } = await backendCall('assets.stage', {
    app: CODEX_APP, assets: assets.map(asset => ({ path: asset.path, bytes: asset.bytes.length }))
  })
  try {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 256 * 1024) throw new Error('后端分块协议不兼容')
    for (const [index, asset] of assets.entries()) {
      for (let offset = 0; offset < asset.bytes.length; offset += chunkBytes) {
        await backendCall('assets.chunk', { stageId, index, offset, contentBase64: toBase64(asset.bytes.subarray(offset, offset + chunkBytes)) })
      }
    }
    return await backendCall('assets.commit', { stageId })
  } finally {
    await backendCall('assets.discard', { stageId }).catch(() => {})
  }
}

/** 解压并校验宠物包 → { id, manifestText, sheetBytes }；不合法抛错 */
export function validatePetPackage(zipBytes, expectId) {
  let files
  try {
    files = unzipSync(zipBytes)
  } catch {
    throw new Error('宠物包不是有效的 zip 文件')
  }
  const names = Object.keys(files)
  const manifestName = names.find(n => n === 'pet.json' || n.endsWith('/pet.json'))
  const sheetName = names.find(n => n === 'spritesheet.webp' || n.endsWith('/spritesheet.webp'))
  if (!manifestName) throw new Error('宠物包缺少 pet.json')
  if (!sheetName) throw new Error('宠物包缺少 spritesheet.webp')
  const manifestText = new TextDecoder().decode(files[manifestName])
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    throw new Error('pet.json 不是有效的 JSON')
  }
  // 真实包结构（实测 codex-pets.net）：{ id, displayName, description, spritesheetPath, spriteVersionNumber, kind }
  if (!manifest || typeof manifest !== 'object' ||
      (!manifest.id && !manifest.name && !manifest.displayName)) {
    throw new Error('pet.json 缺少 id / displayName 字段')
  }
  const sheetBytes = files[sheetName]
  if (sheetBytes.length === 0) throw new Error('spritesheet.webp 为空')
  const version = manifest.spriteVersionNumber === 2 ? 2 : 1
  // webp 尺寸解析（VP8X/VP8/VP8L 头）——只校验高度量级与版本粗匹配
  const approx = webpSize(sheetBytes)
  if (approx) {
    const expectH = version === 2 ? 2288 : 1872
    if (Math.abs(approx.height - expectH) > 8) {
      throw new Error(`spritesheet 高度 ${approx.height}px 与 V${version} 期望 ${expectH}px 不符（pet.json spriteVersionNumber 可能标注错误）`)
    }
  }
  const id = expectId ?? (manifest.id ? slugify(manifest.id) : slugify(manifest.displayName ?? manifest.name))
  return { id, manifestText, sheetBytes, manifest, version }
}

/** 极简 webp 尺寸探测（VP8X 24px canvas / VP8 keyframe / VP8L） */
export function webpSize(bytes) {
  if (bytes.length < 30 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF') return null
  const format = String.fromCharCode(...bytes.subarray(12, 16))
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (format === 'VP8X') {
    const width = 1 + (bytes[24] | bytes[25] << 8 | bytes[26] << 16)
    const height = 1 + (bytes[27] | bytes[28] << 8 | bytes[29] << 16)
    return { width, height }
  }
  if (format === 'VP8 ') {
    return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff }
  }
  if (format === 'VP8L') {
    const bits = dv.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

function slugify(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'pet'
}

/** 写入目标（pets/<id>/ 下两文件） */
export function installTargets(petId) {
  return [
    `pets/${petId}/pet.json`,
    `pets/${petId}/spritesheet.webp`
  ]
}

/** Legacy package-shape helper; installation now uses writeAssetChunks, not this transport. */
export function writeAssetsPayload(pkg) {
  return {
    app: CODEX_APP,
    assets: [
      { path: `pets/${pkg.id}/pet.json`, contentText: pkg.manifestText },
      { path: `pets/${pkg.id}/spritesheet.webp`, contentBase64: toBase64(pkg.sheetBytes) }
    ],
    confirmed: true
  }
}

/** 检测本机 Codex（installed = ~/.codex/config.toml 存在） */
export async function detectCodex() {
  const apps = await backendCall('apps')
  const codex = apps.find(a => a.app === CODEX_APP)
  if (!codex) throw new Error('插件后端不支持 Codex（请更新插件）')
  return { installed: Boolean(codex.installed), active: Boolean(codex.active), configPaths: codex.configPaths ?? [] }
}

/** 列出已安装宠物（pets/ 下的目录名与 mtime） */
export async function listInstalled() {
  const res = await listInstalledAssets()
  return (res?.entries ?? [])
    .filter(e => e.isDir)
    .map(e => ({ id: e.name, modifiedAt: e.modifiedAt }))
}

/** 完整安装流程（UI 状态机回调 onStep(step, detail)） */
export async function installPet(pet, onStep = () => {}) {
  onStep('detect', '检测本机 Codex…')
  const detected = await detectCodex()
  if (!detected.installed) {
    throw new Error('未检测到 Codex（~/.codex/config.toml 不存在）。请先安装并运行一次 Codex CLI，或检查配置目录。')
  }
  onStep('download', '下载宠物包…')
  const zipBytes = await downloadBinary(pet.downloadUrl)
  onStep('verify', '校验宠物包…')
  const pkg = validatePetPackage(zipBytes, pet.id)
  onStep('write', '写入 ~/.codex/pets（需确认）…')
  const result = await writeAssetChunks([
    { path: `pets/${pkg.id}/pet.json`, bytes: new TextEncoder().encode(pkg.manifestText) },
    { path: `pets/${pkg.id}/spritesheet.webp`, bytes: pkg.sheetBytes }
  ])
  onStep('done', null)
  return { ...result, petId: pkg.id }
}

/** 删除已安装宠物（宿主原生确认） */
export async function deleteInstalled(petId) {
  return backendCall('assets.delete', { app: CODEX_APP, paths: [`pets/${petId}`] })
}
