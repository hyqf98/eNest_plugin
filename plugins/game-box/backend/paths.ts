/**
 * 路径与文件名处理。清洗规则沿用源项目：
 * Windows 非法字符转下划线、合并连续下划线、去掉首尾的点/空格/下划线、空名回退。
 */

const ILLEGAL = /[<>:"|?*\\/]/g
const CONTROL = /[\u0000-\u001f]/g
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
/** Windows 路径段上限 255 个 UTF-16 码元；留余量给分卷后缀与临时后缀 */
const MAX_SEGMENT = 180

/** 清洗单个路径段，使其可以作为 Windows 文件夹或文件名 */
export function sanitizeSegment(name: string, fallback = 'Untitled'): string {
  let value = name.normalize('NFC')
  value = value.replace(CONTROL, ' ')
  value = value.replace(ILLEGAL, '_')
  value = value.replace(/\s+/g, ' ').trim()
  value = value.replace(/_+/g, '_')
  value = value.replace(/^[.\s_]+|[.\s_]+$/g, '')
  if (!value) return fallback
  if (RESERVED.test(value)) value = `_${value}`
  if (value.length > MAX_SEGMENT) value = value.slice(0, MAX_SEGMENT).replace(/[\s._]+$/, '')
  return value || fallback
}

/** 清洗路径的最后一段，前面各段原样保留 */
export function sanitizeLastSegment(path: string, join: (...parts: string[]) => string, dirname: (value: string) => string, basename: (value: string) => string): string {
  const parent = dirname(path)
  const name = sanitizeSegment(basename(path))
  return parent && parent !== path ? join(parent, name) : name
}

/** 文件主名与扩展名（点开头的名字如 ".part01" 视为无扩展名） */
export function splitName(fileName: string): { stem: string; ext: string } {
  const index = fileName.lastIndexOf('.')
  if (index <= 0) return { stem: fileName, ext: '' }
  return { stem: fileName.slice(0, index), ext: fileName.slice(index + 1).toLowerCase() }
}

export const ARCHIVE_EXTENSIONS = new Set(['zip', '7z', 'rar', 'exe'])

/** 是否是可安装的压缩包或可执行文件 */
export function isInstallableArchive(fileName: string): boolean {
  const ext = splitName(fileName).ext
  if (ARCHIVE_EXTENSIONS.has(ext)) return true
  // 分卷续卷：.z01 .z99 / .r00 .r99 / .001 .999
  return /^(z|r)\d{2}$/.test(ext) || /^\d{3}$/.test(ext)
}

export type ArchiveFamily = 'zip-split' | '7z-split' | 'rar-split' | 'single'

/**
 * 识别一个文件名属于哪类压缩包，以及它在分卷集合里是不是主卷。
 * - zip-split：主卷 .zip，续卷 .z01..z99
 * - 7z-split：主卷 .7z.001，续卷 .7z.002..（也兼容无 .7z 的 .001）
 * - rar-split：主卷 .part01.rar / .part1.rar / .rar，续卷 .partNN.rar / .rNN
 */
export function classifyArchive(fileName: string): { family: ArchiveFamily; isMain: boolean; base: string } | null {
  const lower = fileName.toLowerCase()
  const { stem, ext } = splitName(lower)
  if (ext === 'zip') return { family: 'zip-split', isMain: true, base: stem }
  if (/^z\d{2}$/.test(ext)) return { family: 'zip-split', isMain: false, base: stem }
  if (ext === 'rar' && !/\.part\d+$/.test(stem)) return { family: 'rar-split', isMain: true, base: stem }
  if (ext === 'rar' && /\.part\d+$/.test(stem)) return { family: 'rar-split', isMain: /\.part0*1$/.test(stem), base: stem.replace(/\.part\d+$/, '') }
  if (/^r\d{2}$/.test(ext)) return { family: 'rar-split', isMain: false, base: stem }
  if (ext === '7z') return { family: '7z-split', isMain: true, base: stem }
  const sevenSplit = /^(.+\.7z)\.(\d{3})$/.exec(lower)
  if (sevenSplit) return { family: '7z-split', isMain: sevenSplit[2] === '001' || sevenSplit[2] === '000', base: sevenSplit[1] }
  const numericSplit = /^(.+)\.(\d{3})$/.exec(lower)
  if (numericSplit && !/\.(zip|rar|7z|exe|z\d\d|r\d\d)$/.test(numericSplit[1])) {
    return { family: '7z-split', isMain: numericSplit[2] === '001' || numericSplit[2] === '000', base: numericSplit[1] }
  }
  if (ext === 'exe') return { family: 'single', isMain: true, base: stem }
  return null
}

/** 从一组文件名里挑出应当交给解压程序的主卷；多个独立压缩包时按主卷逐个返回 */
export function pickMainVolumes(fileNames: string[]): string[] {
  const mains: string[] = []
  for (const name of fileNames) {
    const info = classifyArchive(name)
    if (!info || !info.isMain) continue
    mains.push(name)
  }
  return mains
}

/** 与主卷同主干的续卷文件名（小写比较） */
export function continuationNames(mainVolume: string, candidates: string[]): string[] {
  const info = classifyArchive(mainVolume)
  if (!info) return []
  return candidates.filter(candidate => {
    if (candidate === mainVolume) return false
    const other = classifyArchive(candidate)
    return Boolean(other && other.family === info.family && other.base === info.base)
  })
}

/**
 * 把下载文件集合归并成"安装单元"：
 * - 多卷压缩包只保留主卷（解压程序会自动串联续卷）；
 * - 多个独立压缩包各自成单元；
 * - 无法归类的文件（dll、txt 等）忽略。
 */
export function planInstallUnits(fileNames: string[]): string[] {
  const units: string[] = []
  const seenBases = new Set<string>()
  for (const name of fileNames) {
    const info = classifyArchive(name)
    if (!info) continue
    const key = `${info.family}:${info.base}`
    if (!info.isMain) {
      // 续卷先于主卷出现时先记下 base，等主卷到了再归并；这里不单独成单元。
      continue
    }
    if (seenBases.has(key)) continue
    seenBases.add(key)
    units.push(name)
  }
  return units
}
