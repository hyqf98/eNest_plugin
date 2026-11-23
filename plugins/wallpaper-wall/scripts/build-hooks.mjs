import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const SUPPORTED_TARGETS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64']

/**
 * 壁纸插件构建钩子：把各平台预编译 helper 从 helper-cache/<target>/
 * 复制到发行包的 runtime/helpers/<target>/。源码仓库不提交二进制。
 */
export async function afterBuild({ source, directory, release = false }) {
  const cacheRoot = join(source, 'helper-cache')
  const helpers = []
  if (existsSync(cacheRoot)) {
    for (const target of SUPPORTED_TARGETS) {
      const directoryPath = join(cacheRoot, target)
      if (!existsSync(directoryPath)) continue
      const info = await stat(directoryPath).catch(() => null)
      if (!info?.isDirectory()) continue
      const files = await readdir(directoryPath)
      const executable = target.startsWith('win32-') ? 'wallpaper-host.exe' : 'wallpaper-host'
      if (!files.includes(executable)) continue
      const destination = join(directory, 'runtime', 'helpers', target)
      await mkdir(destination, { recursive: true })
      await cp(directoryPath, destination, { recursive: true, dereference: true })
      helpers.push({ target, executable })
    }
  }
  if (helpers.length) {
    await mkdir(join(directory, 'runtime', 'helpers'), { recursive: true })
    await writeFile(join(directory, 'runtime', 'helpers', 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      version: '0.0.1',
      protocolVersion: 1,
      helpers,
    }, null, 2) + '\n')
  }
  if (release && process.env.ENEST_REQUIRE_ALL_HELPERS === '1' && helpers.length !== SUPPORTED_TARGETS.length) {
    throw new Error(`wallpaper-wall: release requires helpers for ${SUPPORTED_TARGETS.join(', ')}; found ${helpers.map(entry => entry.target).join(', ') || 'none'}`)
  }
}

export async function validateDistribution({ directory, requireRuntime = false }) {
  const root = join(directory, 'runtime', 'helpers')
  if (!existsSync(root)) {
    if (requireRuntime) throw new Error('wallpaper-wall: runtime/helpers is missing')
    return
  }
  const manifestPath = join(root, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error('wallpaper-wall: runtime/helpers/manifest.json is missing')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest?.version !== '0.0.1' || manifest?.protocolVersion !== 1 || !Array.isArray(manifest.helpers)) {
    throw new Error('wallpaper-wall: invalid helper manifest')
  }
  for (const entry of manifest.helpers) {
    if (!SUPPORTED_TARGETS.includes(entry.target)) throw new Error(`wallpaper-wall: unsupported helper target ${entry.target}`)
    const file = join(root, entry.target, entry.executable)
    if (!existsSync(file)) throw new Error(`wallpaper-wall: helper missing for ${entry.target}`)
    const info = await stat(file)
    if (!info.isFile()) throw new Error(`wallpaper-wall: helper for ${entry.target} is not a regular file`)
    const header = await readFile(file, { encoding: null })
    if (entry.target.startsWith('win32-') && !(header[0] === 0x4d && header[1] === 0x5a)) throw new Error('wallpaper-wall: Windows helper is not a PE file')
    if (entry.target.startsWith('linux-') && !(header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46)) throw new Error('wallpaper-wall: Linux helper is not an ELF file')
    if (entry.target.startsWith('darwin-')) {
      const magic = header.readUInt32BE(0)
      const fat = header.readUInt32BE(0)
      if (![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic) && !(fat === 0xcafebabe || fat === 0xbebafeca)) {
        throw new Error('wallpaper-wall: macOS helper is not a Mach-O file')
      }
    }
  }
}
