/**
 * 游戏屋构建钩子：把 vendor-cache 里的 7-Zip 运行文件复制进发行包 runtime/7zip/<target>/。
 * 源码仓库不提交二进制；构建前先 `npm run vendor` 获取。
 *
 * - afterBuild：复制 7z.exe / 7z.dll / License.txt / History.txt，并写入清单；
 * - validateDistribution：发行包必须含解压工具与许可证，且 Windows 可执行文件必须是 PE 格式。
 */
import { cp, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SEVEN_ZIP } from './fetch-7zip.mjs'

const TARGETS = [SEVEN_ZIP.target]
const RUNTIME_DIR = 'runtime/7zip'

export async function afterBuild({ source, directory, release = false }) {
  const cacheRoot = join(source, 'vendor-cache')
  const packed = []
  for (const target of TARGETS) {
    const from = join(cacheRoot, target)
    if (!existsSync(from)) {
      if (release) throw new Error(`game-house: release 需要 vendor-cache/${target}，请先运行 npm run vendor`)
      continue
    }
    const info = await stat(from).catch(() => null)
    if (!info?.isDirectory()) continue
    const destination = join(directory, RUNTIME_DIR, target)
    await mkdir(destination, { recursive: true })
    await cp(from, destination, { recursive: true, dereference: true })
    packed.push(target)
  }
  if (packed.length) {
    await mkdir(join(directory, RUNTIME_DIR), { recursive: true })
    await writeFile(join(directory, RUNTIME_DIR, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      tool: '7-Zip',
      version: SEVEN_ZIP.version,
      license: 'GNU LGPL with unRAR license restriction; see License.txt',
      targets: packed,
    }, null, 2) + '\n')
  }
}

export async function validateDistribution({ directory, requireRuntime = false }) {
  const root = join(directory, RUNTIME_DIR)
  if (!existsSync(root)) {
    if (requireRuntime) throw new Error('game-house: runtime/7zip is missing')
    return
  }
  const manifestPath = join(root, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error('game-house: runtime/7zip/manifest.json is missing')
  let manifest
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) }
  catch { throw new Error('game-house: runtime/7zip/manifest.json is not valid JSON') }
  if (manifest?.schemaVersion !== 1 || manifest?.tool !== '7-Zip' || manifest?.version !== SEVEN_ZIP.version || !Array.isArray(manifest.targets)) {
    throw new Error('game-house: invalid 7-Zip manifest')
  }
  for (const target of manifest.targets) {
    if (!TARGETS.includes(target)) throw new Error(`game-house: unsupported 7-Zip target ${target}`)
    for (const name of SEVEN_ZIP.files) {
      const file = join(root, target, name)
      if (!existsSync(file)) throw new Error(`game-house: 7-Zip file missing for ${target}: ${name}`)
      const info = await stat(file)
      if (!info.isFile()) throw new Error(`game-house: 7-Zip ${name} for ${target} is not a regular file`)
      if (info.size === 0) throw new Error(`game-house: 7-Zip ${name} for ${target} is empty`)
      if (name.endsWith('.exe') || name.endsWith('.dll')) {
        const handle = await open(file, 'r')
        try {
          const header = Buffer.alloc(64)
          await handle.read(header, 0, 64, 0)
          // PE 文件以 MZ 开头，DOS 头里给出 PE 签名偏移
          if (!(header[0] === 0x4d && header[1] === 0x5a)) throw new Error(`game-house: ${name} for ${target} is not a PE file`)
          const peOffset = header.readUInt32LE(0x3c)
          if (peOffset <= 0 || peOffset > 1024 * 1024) throw new Error(`game-house: ${name} for ${target} has no PE header offset`)
          const signature = Buffer.alloc(4)
          const { bytesRead } = await handle.read(signature, 0, 4, peOffset)
          if (bytesRead !== 4 || signature.readUInt32LE(0) !== 0x00004550) throw new Error(`game-house: ${name} for ${target} has no PE signature`)
        } finally {
          await handle.close()
        }
      }
    }
  }
  // LGPL 再分发义务：许可证必须随包
  for (const target of manifest.targets) {
    const license = await readFile(join(root, target, 'License.txt'), 'utf8').catch(() => '')
    if (!/GNU LGPL/i.test(license) || !/unRAR license restriction/i.test(license)) {
      throw new Error(`game-house: 7-Zip License.txt for ${target} does not carry the LGPL / unRAR terms`)
    }
  }
}
