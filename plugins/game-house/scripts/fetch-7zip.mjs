#!/usr/bin/env node
/**
 * 获取 7-Zip 运行文件到 vendor-cache/（源码仓库不提交二进制，构建钩子从这里复制进 runtime/）。
 *
 * 用法：node scripts/fetch-7zip.mjs
 *
 * 流程：下载官方安装包与官方独立解压器 → 核对官方 sha256 → 用 7zr.exe 从安装包里解出
 * 7z.exe + 7z.dll + License.txt + History.txt → 删除安装包、解压器与中间文件。
 * 任一步摘要不符立即中止，不留下任何文件。
 *
 * 目前只支持 Windows x64（游戏包都是 Windows 程序）。macOS / Linux 的官方包是 tar.xz，
 * 仓库里没有 xz 解码器，需要时再补。
 *
 * 7-Zip 以 GNU LGPL 发布（7z.dll 部分代码带 unRAR 许可限制与 BSD 条款），
 * 二进制再分发的义务是附带 License.txt，构建钩子会把它一并放进 runtime/。
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SEVEN_ZIP = Object.freeze({
  version: '26.06',
  target: 'win32-x64',
  tool: '7z.exe',
  engine: '7z.dll',
  /** 需要随包分发的文件；License.txt 是 LGPL 再分发的义务 */
  files: ['7z.exe', '7z.dll', 'License.txt', 'History.txt'],
  release: 'https://github.com/ip7z/7zip/releases/download/26.06',
  assets: {
    installer: { name: '7z2606-x64.exe', sha256: '9b697f65ecc2d9b0152f5ee96d72dde522a7827690349d9307935dacf40f42ec' },
    unpacker: { name: '7zr.exe', sha256: 'e80db2dad715a6c5adabe292d31ed54e11f4e9b99ca349827b50573b175891bc' },
  },
})

const HERE = dirname(fileURLToPath(import.meta.url))
export const CACHE = join(HERE, '..', 'vendor-cache')

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${url}`)
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function verify(path, expected, label) {
  const actual = await sha256(path)
  if (actual !== expected) throw new Error(`${label} 的 sha256 与官方不符。\n  实际 ${actual}\n  官方 ${expected}`)
  console.log(`  ${label} sha256 核对通过`)
}

function run(tool, args) {
  return new Promise((resolve, reject) => {
    execFile(tool, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${args[0]} 失败：${(stderr || stdout || error.message).trim().slice(0, 400)}`))
      else resolve(stdout)
    })
  })
}

/** 检查缓存是否已就绪且未被改动 */
export async function cacheStatus(cache = CACHE) {
  const output = join(cache, SEVEN_ZIP.target)
  for (const name of SEVEN_ZIP.files) {
    try {
      const info = await stat(join(output, name))
      if (!info.isFile() || info.size === 0) return { ready: false, output }
    } catch { return { ready: false, output } }
  }
  const digest = await sha256(join(output, SEVEN_ZIP.tool))
  const engine = await sha256(join(output, SEVEN_ZIP.engine))
  return { ready: true, output, toolSha256: digest, engineSha256: engine }
}

async function main() {
  if (process.platform !== 'win32') {
    console.error(`fetch-7zip 目前只支持 Windows（当前 ${process.platform}）。macOS / Linux 的官方包是 tar.xz，尚未接入。`)
    process.exit(1)
  }
  const status = await cacheStatus()
  console.log(`7-Zip ${SEVEN_ZIP.version} → vendor-cache/${SEVEN_ZIP.target}`)
  const staging = await mkdtemp(join(tmpdir(), 'game-house-7zip-'))
  try {
    const installerPath = join(staging, SEVEN_ZIP.assets.installer.name)
    const unpackerPath = join(staging, SEVEN_ZIP.assets.unpacker.name)
    console.log('  下载官方安装包与解压器…')
    await download(`${SEVEN_ZIP.release}/${SEVEN_ZIP.assets.installer.name}`, installerPath)
    await download(`${SEVEN_ZIP.release}/${SEVEN_ZIP.assets.unpacker.name}`, unpackerPath)
    await verify(installerPath, SEVEN_ZIP.assets.installer.sha256, '安装包')
    await verify(unpackerPath, SEVEN_ZIP.assets.unpacker.sha256, '解压器')
    const extracted = join(staging, 'extracted')
    await mkdir(extracted, { recursive: true })
    await run(unpackerPath, ['x', installerPath, `-o${extracted}`, '-y', '-bso0', '-bsp0'])
    await rm(status.output, { force: true, recursive: true })
    await mkdir(status.output, { recursive: true })
    for (const name of SEVEN_ZIP.files) await copyFile(join(extracted, name), join(status.output, name))
    const toolStat = await stat(join(status.output, SEVEN_ZIP.tool))
    console.log(`  就绪：${join(status.output, SEVEN_ZIP.tool)}（${toolStat.size} 字节）`)
  } finally {
    await rm(staging, { force: true, recursive: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message)
    process.exit(1)
  })
}
