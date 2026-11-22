import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  CurrentWallpaper,
  DisplayInfo,
  SetWallpaperRequest,
  SetWallpaperResult,
  StaticWallpaperCapabilities,
  WallpaperFit,
} from '@backend/contracts'
import { WALLPAPER_FITS } from '@backend/contracts'
import { loadSettings, libraryStore } from '@backend/store'
import { fail } from '@backend/util'
import { windowsCurrentWallpapers, windowsListDisplays, windowsSetStatic } from './windows'
import { macosCurrentWallpapers, macosListDisplays, macosSetStatic } from './macos'
import { LinuxWallpaperService } from './linux'

const linux = new LinuxWallpaperService()

export class StaticWallpaperService {
  capabilities(): StaticWallpaperCapabilities {
    if (process.platform === 'win32') {
      return {
        supported: true,
        platform: 'win32',
        session: 'Windows',
        multiMonitor: true,
        fits: [...WALLPAPER_FITS],
        current: true,
      }
    }
    if (process.platform === 'darwin') {
      return {
        supported: true,
        platform: 'darwin',
        session: 'macOS',
        multiMonitor: true,
        fits: ['fill', 'fit', 'stretch', 'center'],
        current: true,
      }
    }
    const capability = linux.capabilities()
    const session = linux.session()
    return {
      supported: capability.supported,
      platform: 'linux',
      session: session.label,
      multiMonitor: session.kind !== 'unknown',
      fits: capability.fits,
      current: session.kind !== 'kde',
      reason: capability.reason,
    }
  }

  async listDisplays(): Promise<DisplayInfo[]> {
    if (process.platform === 'win32') return windowsListDisplays()
    if (process.platform === 'darwin') return macosListDisplays()
    return linux.listDisplays()
  }

  async setStatic(request: SetWallpaperRequest): Promise<SetWallpaperResult> {
    const settings = await loadSettings()
    const path = await this.resolvePath(request)
    const fit = request.fit && WALLPAPER_FITS.includes(request.fit) ? request.fit : settings.defaultFit
    const indexes = normalizeDisplayIndexes(request.displayIds)
    if (process.platform === 'win32') {
      if (indexes.length) {
        const applied: SetWallpaperResult['applied'] = []
        for (const index of indexes) {
          const result = await windowsSetStatic(path, fit, index)
          applied.push(...result.applied)
        }
        return { ok: true, applied }
      }
      return windowsSetStatic(path, fit, null)
    }
    if (process.platform === 'darwin') {
      if (indexes.length) {
        const applied: SetWallpaperResult['applied'] = []
        for (const index of indexes) {
          const result = await macosSetStatic(path, fit, index)
          applied.push(...result.applied)
        }
        return { ok: true, applied }
      }
      return macosSetStatic(path, fit, null)
    }
    return linux.setStatic(path, fit)
  }

  async current(): Promise<CurrentWallpaper[]> {
    if (process.platform === 'win32') return windowsCurrentWallpapers()
    if (process.platform === 'darwin') return macosCurrentWallpapers()
    return linux.current()
  }

  async dispose(): Promise<void> {
    if (process.platform === 'linux') await linux.dispose()
  }

  private async resolvePath(request: SetWallpaperRequest): Promise<string> {
    const settings = await loadSettings()
    if (request.libraryId) {
      await libraryStore.load()
      const item = libraryStore.get(request.libraryId)
      if (!item) fail('LIBRARY_FILE_MISSING', '本地库项目不存在')
      if (!settings.libraryPath) fail('LIBRARY_NOT_CONFIGURED', '请先设置壁纸库目录')
      const root = resolve(settings.libraryPath)
      const candidate = resolve(join(root, item.fileName))
      if (!isInside(root, candidate)) fail('LIBRARY_PATH_INVALID', '壁纸文件不在当前壁纸库目录内')
      if (!existsSync(candidate)) fail('LIBRARY_FILE_MISSING', `壁纸文件已丢失：${item.fileName}`)
      return candidate
    }
    if (!request.path || !isAbsolute(request.path)) fail('INVALID_ARGUMENT', '需要 libraryId 或绝对壁纸路径')
    if (!settings.libraryPath) fail('LIBRARY_NOT_CONFIGURED', '请先设置壁纸库目录')
    const root = resolve(settings.libraryPath)
    const candidate = resolve(request.path)
    if (!isInside(root, candidate)) fail('LIBRARY_PATH_INVALID', '只允许设置当前壁纸库内的文件')
    const info = await stat(candidate).catch(() => null)
    if (!info?.isFile()) fail('LIBRARY_FILE_MISSING', '壁纸文件不存在')
    return candidate
  }
}

function normalizeDisplayIndexes(displayIds: string[] | undefined): number[] {
  if (!Array.isArray(displayIds)) return []
  return [...new Set(displayIds
    .map(value => /^\d+$/.test(value) ? Number(value) : NaN)
    .filter((value): value is number => Number.isSafeInteger(value) && value >= 0))]
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

export const staticWallpaperService = new StaticWallpaperService()

export type { WallpaperFit }
