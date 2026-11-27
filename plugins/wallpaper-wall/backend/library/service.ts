import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, rename, rm, stat, unlink } from 'node:fs/promises'
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'
import type {
  DownloadJobStart,
  DownloadProgress,
  ImportLocalRequest,
  ImportUrlRequest,
  LibraryFolderResult,
  LibraryItem,
  LibraryListResult,
  MediaPreviewResult,
  ThumbResult,
  WallpaperItem,
} from '@backend/contracts'
import { resolveFileHandle, postEvent, acquireActivity, onShutdown } from '@backend/runtime'
import { downloadToFile } from '@backend/net'
import { pluginPaths, suggestedLibraryPath } from '@backend/paths'
import { libraryStore, loadSettings, updateSettings } from '@backend/store'
import { resolveAsset } from '@backend/sources/registry'
import { staticWallpaperService } from '@backend/wallpaper'
import { getLibraryPreview, getLibraryThumbnail, getPreview, getThumbnail } from '@backend/thumbs'
import { selectVideoVariant } from '@backend/contracts'
import {
  errorMessage,
  extensionFor,
  fail,
  isHttpUrl,
  newId,
  safeFileName,
  shortHash,
} from '@backend/util'

const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
const MAX_CONCURRENT_DOWNLOADS = 2

interface Job {
  id: string
  item: WallpaperItem
  controller: AbortController
  status: DownloadProgress['phase']
  task: () => Promise<void>
}

const jobs = new Map<string, Job>()
const queue: Job[] = []
let active = 0

export async function startDownload(item: WallpaperItem): Promise<DownloadJobStart> {
  if (!item.downloadAllowed) fail('INVALID_ARGUMENT', '此来源不允许下载该壁纸')
  const settings = await loadSettings()
  if (!settings.libraryPath) fail('LIBRARY_NOT_CONFIGURED', '请先在设置中选择壁纸库目录')
  const id = newId('download')
  const controller = new AbortController()
  const job: Job = {
    id,
    item,
    controller,
    status: 'queued',
    task: async () => { await runDownload(job) },
  }
  jobs.set(id, job)
  queue.push(job)
  emit({ jobId: id, sourceId: item.sourceId, remoteId: item.remoteId, title: item.title, phase: 'queued' })
  void pump()
  return { jobId: id }
}

export function cancelDownload(jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job) return false
  job.controller.abort()
  const index = queue.indexOf(job)
  if (index >= 0) {
    queue.splice(index, 1)
    job.status = 'cancelled'
    emit({ jobId, sourceId: job.item.sourceId, remoteId: job.item.remoteId, title: job.item.title, phase: 'cancelled' })
    jobs.delete(jobId)
  }
  return true
}

export function importLocalWallpaper(request: ImportLocalRequest): Promise<LibraryItem> {
  const controller = new AbortController()
  const task = importLocalFile(request, controller.signal)
  const unregister = onShutdown(async () => { controller.abort(); await task.catch(() => {}) })
  return task.finally(unregister)
}

async function importLocalFile(request: ImportLocalRequest, signal: AbortSignal): Promise<LibraryItem> {
  const settings = await loadSettings()
  if (!settings.libraryPath) fail('LIBRARY_NOT_CONFIGURED', '请先在设置中选择壁纸库目录')
  const sourcePath = await resolveFileHandle(request.handleId, 'read')
  const info = await stat(sourcePath)
  if (!info.isFile()) fail('INVALID_ARGUMENT', '选择的不是普通文件')
  if (info.size > MAX_DOWNLOAD_BYTES) fail('INVALID_ARGUMENT', '文件超过 256MB')
  const mediaType = request.mediaType || inferLocalMediaType(sourcePath)
  if (mediaType === 'web') fail('INVALID_ARGUMENT', 'Web 壁纸请使用 URL 导入')
  const root = await ensureLibraryRoot(settings.libraryPath)
  signal.throwIfAborted()
  const digest = createHash('sha256')
  const stage = await mkdtemp(join(root, '.enest-import-')), stagedFile = join(stage, 'content')
  let bytes = 0, hash: string, fileName: string, target: string
  try {
    await pipeline(createReadStream(sourcePath), async function* (chunks) {
      for await (const chunk of chunks) {
        bytes += chunk.length
        if (bytes > MAX_DOWNLOAD_BYTES) fail('INVALID_ARGUMENT', '文件超过 256MB')
        digest.update(chunk)
        yield chunk
      }
    }, createWriteStream(stagedFile, { flags: 'wx' }), { signal })
    signal.throwIfAborted()
    hash = digest.digest('hex')
    const existing = libraryStore.list().find(item => item.sha256 === hash)
    if (existing) return existing
    const extension = sourcePath.includes('.') ? sourcePath.slice(sourcePath.lastIndexOf('.')).toLowerCase() : mediaType === 'video' ? '.mp4' : '.jpg'
    fileName = uniqueFileName(root, `local-${shortHash(hash)}${safeExtension(extension)}`)
    target = join(root, fileName)
    await rename(stagedFile, target)
  } finally { await rm(stage, { recursive: true, force: true }) }
  const item: WallpaperItem = {
    sourceId: 'local',
    remoteId: hash,
    title: request.title?.trim() || safeFileName(sourcePath, '本地壁纸'),
    mediaType,
    thumbUrl: '',
    previewUrl: '',
    fullUrl: '',
    width: undefined,
    height: undefined,
    author: undefined,
    license: '用户本地文件',
    downloadAllowed: true,
    exportAllowed: true,
    meta: { originalName: safeFileName(sourcePath) },
  }
  const libraryItem: LibraryItem = {
    id: newId('lib'),
    item,
    fileName,
    bytes,
    sha256: hash,
    createdAt: Date.now(),
    favorite: false,
    displayPath: target,
    mediaType,
  }
  return libraryStore.add(libraryItem)
}

export async function importUrlWallpaper(request: ImportUrlRequest): Promise<LibraryItem> {
  const url = request.url.trim()
  if (!isHttpUrl(url)) fail('INVALID_ARGUMENT', '请输入 http(s) 图片/视频地址')
  const settings = await loadSettings()
  if (!settings.libraryPath) fail('LIBRARY_NOT_CONFIGURED', '请先在设置中选择壁纸库目录')
  const root = await ensureLibraryRoot(settings.libraryPath)
  const mediaType = request.mediaType || inferUrlMediaType(url)
  if (mediaType === 'web') fail('INVALID_ARGUMENT', 'Web 壁纸请直接使用 URL 预览/动态设置')
  const extension = extensionFor({ mediaType, fullUrl: url })
  const tempPath = join(pluginPaths().downloads, `${newId('url')}${extension}`)
  const result = await downloadToFile(url, { targetPath: tempPath, maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: 120_000 })
  try {
    const existing = libraryStore.list().find(item => item.sha256 === result.sha256)
    if (existing) return existing
    const fileName = uniqueFileName(root, `url-${shortHash(result.sha256)}${extension}`)
    const target = join(root, fileName)
    await rename(tempPath, target)
    const item: WallpaperItem = {
      sourceId: 'url',
      remoteId: result.sha256,
      title: request.title?.trim() || safeFileName(new URL(url).pathname, 'URL 壁纸'),
      mediaType,
      thumbUrl: '',
      previewUrl: '',
      fullUrl: url,
      author: request.author?.trim() || undefined,
      license: request.license?.trim() || '用户导入 URL',
      sourceUrl: request.sourceUrl?.trim() || url,
      downloadAllowed: true,
      exportAllowed: true,
      mime: result.contentType || undefined,
    }
    return libraryStore.add({
      id: newId('lib'),
      item,
      fileName,
      bytes: result.bytes,
      sha256: result.sha256,
      createdAt: Date.now(),
      favorite: false,
      displayPath: target,
      mediaType,
    })
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

export async function listLibrary(): Promise<LibraryListResult> {
  await libraryStore.load()
  const settings = await loadSettings()
  return {
    items: libraryStore.list(),
    totalBytes: libraryStore.totalBytes(),
    folder: await folderStatus(settings.libraryPath),
  }
}

export async function removeLibraryItem(id: string, deleteFile: boolean): Promise<boolean> {
  await libraryStore.load()
  const item = libraryStore.get(id)
  if (!item) return false
  if (deleteFile) {
    const settings = await loadSettings()
    if (settings.libraryPath) {
      const target = resolve(join(settings.libraryPath, item.fileName))
      const current = await staticWallpaperService.current().catch(() => [])
      const normalize = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
      const inUse = current.some(entry => entry.path && normalize(entry.path) === normalize(target))
      if (inUse) fail('INVALID_ARGUMENT', '当前壁纸正在使用该文件，请先切换到其它壁纸再删除')
      await unlink(target).catch(() => {})
    }
  }
  return libraryStore.remove(id)
}

export async function setFavorite(id: string, favorite: boolean): Promise<LibraryItem | null> {
  return libraryStore.update(id, { favorite })
}

export async function libraryThumbnail(id: string): Promise<ThumbResult> {
  await libraryStore.load()
  const item = libraryStore.get(id)
  if (!item) fail('LIBRARY_FILE_MISSING', '本地库项目不存在')
  const settings = await loadSettings()
  const filePath = settings.libraryPath ? join(settings.libraryPath, item.fileName) : null
  return getLibraryThumbnail(item, filePath)
}

export async function libraryPreview(id: string): Promise<MediaPreviewResult> {
  await libraryStore.load()
  const item = libraryStore.get(id)
  if (!item) fail('LIBRARY_FILE_MISSING', '本地库项目不存在')
  const settings = await loadSettings()
  const filePath = settings.libraryPath ? join(settings.libraryPath, item.fileName) : null
  return getLibraryPreview(item, filePath)
}

export async function sourcePreview(item: WallpaperItem): Promise<MediaPreviewResult> {
  return getPreview(item)
}

export async function sourceThumbnail(item: WallpaperItem): Promise<ThumbResult> {
  if (!item.thumbUrl) return { dataUrl: null, bytes: 0 }
  try {
    return await getThumbnail({ url: item.thumbUrl, headers: item.thumbHeaders })
  } catch (error) {
    return { dataUrl: null, bytes: 0, message: errorMessage(error) }
  }
}

export async function setLibraryFolder(handleId: string): Promise<LibraryFolderResult> {
  const path = await resolveFileHandle(handleId, 'write')
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) fail('LIBRARY_PATH_INVALID', '选择的不是目录')
  await access(path, fsConstants.W_OK).catch(() => fail('LIBRARY_PATH_INVALID', '目录不可写'))
  await updateSettings({ libraryPath: path })
  return folderStatus(path)
}

export async function useDefaultLibraryFolder(): Promise<LibraryFolderResult> {
  const path = suggestedLibraryPath()
  await mkdir(path, { recursive: true })
  await updateSettings({ libraryPath: path })
  return folderStatus(path)
}

export function libraryFilePath(item: LibraryItem): string | null {
  return item.displayPath || null
}

export function shutdownDownloads(): void {
  for (const job of jobs.values()) job.controller.abort()
  queue.length = 0
}

async function runDownload(job: Job): Promise<void> {
  const release = await acquireActivity(`download:${job.item.sourceId}`)
  const tempExtension = extensionFor(job.item)
  const tempPath = join(pluginPaths().downloads, `${job.id}${tempExtension}`)
  try {
    job.status = 'downloading'
    emit({ jobId: job.id, sourceId: job.item.sourceId, remoteId: job.item.remoteId, title: job.item.title, phase: 'downloading', percent: 0 })
    const settings = await loadSettings()
    const directVideo = job.item.mediaType === 'video' && job.item.variants?.length
    const resolved = directVideo ? null : await resolveAsset(job.item)
    const downloadUrl = directVideo
      ? selectVideoVariant(job.item, settings.engineSettings.videoQuality)
      : resolved?.url ?? job.item.fullUrl
    if (!settings.libraryPath) fail('LIBRARY_NOT_CONFIGURED', '壁纸库目录未设置')
    const root = await ensureLibraryRoot(settings.libraryPath)
    const result = await downloadToFile(downloadUrl, {
      targetPath: tempPath,
      headers: { ...job.item.downloadHeaders, ...(resolved?.headers ?? {}) },
      maxBytes: MAX_DOWNLOAD_BYTES,
      timeoutMs: 180_000,
      signal: job.controller.signal,
      onProgress: (received, total) => emit({
        jobId: job.id,
        sourceId: job.item.sourceId,
        remoteId: job.item.remoteId,
        title: job.item.title,
        phase: 'downloading',
        receivedBytes: received,
        totalBytes: total,
        percent: total ? Math.min(99, Math.round(received / total * 100)) : undefined,
      }),
    })
    if (job.controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
    emit({ jobId: job.id, sourceId: job.item.sourceId, remoteId: job.item.remoteId, title: job.item.title, phase: 'verifying', percent: 99 })
    const existing = libraryStore.list().find(item => item.sha256 === result.sha256)
    if (existing) {
      emit({ jobId: job.id, sourceId: job.item.sourceId, remoteId: job.item.remoteId, title: job.item.title, phase: 'done', percent: 100, libraryId: existing.id, message: '已存在相同文件' })
      return
    }
    const extension = extensionFor({ mediaType: job.item.mediaType, mime: result.contentType, fullUrl: downloadUrl })
    const fileName = uniqueFileName(root, `${job.item.sourceId}-${job.item.remoteId}-${shortHash(result.sha256, 10)}${extension}`)
    const target = join(root, fileName)
    await rename(tempPath, target)
    const libraryItem: LibraryItem = {
      id: newId('lib'),
      item: { ...job.item, mime: job.item.mime || result.contentType },
      fileName,
      bytes: result.bytes,
      sha256: result.sha256,
      createdAt: Date.now(),
      favorite: false,
      displayPath: target,
      mediaType: job.item.mediaType,
    }
    await libraryStore.add(libraryItem)
    emit({ jobId: job.id, sourceId: job.item.sourceId, remoteId: job.item.remoteId, title: job.item.title, phase: 'done', percent: 100, libraryId: libraryItem.id })
  } catch (error) {
    const cancelled = job.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
    emit({
      jobId: job.id,
      sourceId: job.item.sourceId,
      remoteId: job.item.remoteId,
      title: job.item.title,
      phase: cancelled ? 'cancelled' : 'failed',
      message: cancelled ? '已取消' : errorMessage(error),
    })
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
    release()
    jobs.delete(job.id)
  }
}

async function pump(): Promise<void> {
  while (active < MAX_CONCURRENT_DOWNLOADS && queue.length) {
    const job = queue.shift()
    if (!job) break
    active += 1
    void job.task().finally(() => {
      active -= 1
      void pump()
    })
  }
}

function emit(progress: DownloadProgress): void {
  postEvent('download.progress', progress)
}

async function folderStatus(path: string | null): Promise<LibraryFolderResult> {
  if (!path) return { path: null, exists: false, writable: false, message: '尚未选择壁纸目录' }
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) return { path, exists: false, writable: false, message: '目录不存在' }
  try {
    await access(path, fsConstants.W_OK)
    return { path, exists: true, writable: true }
  } catch {
    return { path, exists: true, writable: false, message: '目录不可写' }
  }
}

async function ensureLibraryRoot(path: string): Promise<string> {
  const root = resolve(path)
  await mkdir(root, { recursive: true })
  await access(root, fsConstants.W_OK).catch(() => fail('LIBRARY_PATH_INVALID', '壁纸库目录不可写'))
  return root
}

function uniqueFileName(_root: string, fileName: string): string {
  return safeFileName(fileName, 'wallpaper')
}

function safeExtension(extension: string): string {
  return /^\.(jpe?g|png|webp|gif|mp4|webm|avif)$/i.test(extension) ? extension.toLowerCase() : '.jpg'
}

function inferLocalMediaType(path: string): WallpaperItem['mediaType'] {
  const lower = path.toLowerCase()
  if (/\.(mp4|webm|mov|mkv)$/.test(lower)) return 'video'
  if (/\.gif$/.test(lower)) return 'gif'
  return 'image'
}

function inferUrlMediaType(url: string): WallpaperItem['mediaType'] {
  const lower = url.toLowerCase()
  if (/\.(mp4|webm)(\?|$)/.test(lower)) return 'video'
  if (/\.gif(\?|$)/.test(lower)) return 'gif'
  return 'image'
}
