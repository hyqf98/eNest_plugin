/**
 * 任务服务的生产依赖：把建任务请求解析成文件清单，以及直链过期后的刷新。
 *
 * 两类来源：
 * - 天翼云分享（分享链接，或站点资源包里的 cloud.189.cn 链接）：解析分享 → 选出文件 →
 *   换取带签名的下载直链。直链约 30 分钟过期，过期后用同一个 fileId 重新换取。
 * - 普通直链（修改器 / MOD 站点）：直接下载，不需要登录。
 */

import { BackendError } from '../adapters/types.ts'
import type { CreateTaskRequest } from '../contracts.ts'
import type { Cloud189Client } from '../cloud189/index.ts'
import { parseDetailId } from '../api/library.ts'
import type { AuthService } from '../library/authService.ts'
import { sourceAdapter } from '../sources/registry.ts'
import type { StoredTask, StoredTaskFile } from '../store.ts'
import { isHttpUrl } from '../util.ts'

const TIANYI = 'cloud.189.cn'

function isShareLink(value: string): boolean {
  return value.includes(TIANYI)
}

/** 分享链接里带的提取码（?pwd=xxxx） */
function accessCodeOf(url: string): string {
  return /[?&]pwd=([^&#]+)/.exec(url)?.[1] ?? ''
}

export interface TaskResolverDeps {
  auth: AuthService
}

/** 一组待下载文件 + 它们来自哪个分享（续传刷新直链时要用） */
export interface Resolved {
  shareId: string
  shareUrl: string
  accessCode: string
  files: StoredTaskFile[]
}

/** 解析文件清单只需要"选了哪些资源"，不需要目录与选项 */
export type ResolveInput = Pick<CreateTaskRequest, 'itemId' | 'packageIds' | 'share' | 'shareFileIds'>

/**
 * 把建任务请求解析成文件清单。
 * packageIds 为空且带 share 时是"粘贴链接"场景；否则是条目详情里选的资源包。
 */
export async function resolveRequest(deps: TaskResolverDeps, request: ResolveInput): Promise<Resolved> {
  const share = request.share
  if (share?.url) {
    const picked = new Set(request.shareFileIds ?? [])
    return resolveShareFiles(deps, share.url, share.accessCode ?? '', picked.size ? picked : undefined)
  }
  if (!request.itemId) throw new BackendError('INVALID_ARGUMENT', '缺少要下载的资源')
  const { itemId } = parseDetailId(request.itemId)
  const ids = (request.packageIds ?? []).filter(Boolean)
  if (!ids.length) throw new BackendError('INVALID_ARGUMENT', '请选择要下载的资源')

  const files: StoredTaskFile[] = []
  const collected = await collectPackages(deps, itemId, ids)
  files.push(...collected.files)
  if (!files.length) throw new BackendError('INVALID_ARGUMENT', '所选资源没有可下载的文件')
  return { shareId: collected.shareId, shareUrl: collected.shareUrl, accessCode: collected.accessCode, files }
}

/**
 * 递归展开资源包。站点文件夹 id 要先向数据源核对状态：只有 folder 才展开
 * （打包中的包 id 是数字串，光看 id 分不出来，必须问数据源）。
 */
async function collectPackages(deps: TaskResolverDeps, itemId: string, ids: string[], depth = 0): Promise<{ files: StoredTaskFile[]; shareId: string; shareUrl: string; accessCode: string }> {
  // 直链（含天翼云分享链接）一定可下载：打包中的包 id 是数字串，不可能是链接。
  // 所以只有出现了非链接的 id（站点文件夹 id）才需要向数据源核对状态，普通直链不白跑一次网络请求。
  const needsLookup = ids.some(id => !isHttpUrl(id))
  const known = new Map(needsLookup ? (await sourceAdapter(sourceKindOf(itemId)).fileList(itemId).catch(() => [])).map(pkg => [pkg.id, pkg.state]) : [])
  const directIds = ids.filter(id => isHttpUrl(id))
  const folderIds = ids.filter(id => !isHttpUrl(id) && known.get(id) === 'folder')
  const files: StoredTaskFile[] = []
  let shareId = ''
  let shareUrl = ''
  let accessCode = ''
  for (const id of directIds) {
    if (isShareLink(id)) {
      // 详情页里点开分享文件夹后选中的单个文件，id 形如「分享链接#文件id」：只取该文件
      const mark = id.lastIndexOf('#')
      const url = mark > 0 ? id.slice(0, mark) : id
      const onlyFileId = mark > 0 ? id.slice(mark + 1) : ''
      const result = await resolveShareFiles(deps, url, accessCodeOf(url), onlyFileId ? new Set([onlyFileId]) : undefined)
      files.push(...result.files)
      if (!shareId) ({ shareId, shareUrl, accessCode } = result)
    } else {
      files.push({ key: id, name: fileNameOfUrl(id), size: 0, downloaded: 0, state: 'pending', url: id, etag: '', lastModified: '' })
    }
  }
  if (folderIds.length) {
    if (depth >= 3) throw new BackendError('INVALID_ARGUMENT', '资源目录层级过深，请进入文件夹选择具体文件')
    const kind = sourceKindOf(itemId)
    for (const folderId of folderIds) {
      const children = await sourceAdapter(kind).fileList(itemId, folderId)
      const nested = await collectPackages(deps, itemId, children.filter(child => child.state === 'ready' || child.state === 'folder').map(child => child.id), depth + 1)
      files.push(...nested.files)
      if (!shareId) ({ shareId, shareUrl, accessCode } = nested)
    }
  }
  return { files, shareId, shareUrl, accessCode }
}

/** 条目 id `源:栏目:站点id` 对应的数据源种类 */
function sourceKindOf(itemId: string): string {
  const parts = itemId.split(':')
  const section = parts.length >= 3 ? parts[1] : ''
  if (section === 'trainer' || section === 'mod') return section
  return parts[0] || 'ode'
}

/** 解析一个分享并换取每个文件的直链；picked 非空时只取这些文件 */
async function resolveShareFiles(deps: TaskResolverDeps, url: string, accessCode: string, picked?: Set<string>): Promise<Resolved> {
  const client = await deps.auth.requireClient()
  const parsed = await client.parseShare(url, accessCode)
  const wanted = parsed.files.filter(file => !picked || picked.has(file.id))
  if (!wanted.length) throw new BackendError('SHARE_EMPTY', '分享里没有可下载的文件')
  const files: StoredTaskFile[] = []
  for (const file of wanted) {
    files.push(await directFileOf(client, parsed.shareId, file.id, file.name, file.size))
  }
  return { shareId: parsed.shareId, shareUrl: url, accessCode, files }
}

/** 换取一个文件的直链；天翼云直链必须带 cookie 与 referer，否则 403 */
async function directFileOf(client: Cloud189Client, shareId: string, fileId: string, name: string, size: number): Promise<StoredTaskFile> {
  const direct = await client.resolveDownloadUrl(shareId, fileId)
  return {
    key: fileId,
    name: name || direct.fileName || fileId,
    size: size || direct.size,
    downloaded: 0,
    state: 'pending',
    url: direct.url,
    headers: direct.headers,
    etag: '',
    lastModified: '',
  }
}

/** 直链过期后重新解析：天翼云用 fileId 再换一次；普通直链没有刷新手段 */
export async function refreshUrl(deps: TaskResolverDeps, task: StoredTask, file: StoredTaskFile): Promise<{ url: string; headers?: Record<string, string> } | null> {
  if (!task.shareId || !task.shareUrl) return null
  const client = await deps.auth.requireClient()
  const direct = await client.resolveDownloadUrl(task.shareId, file.key)
  return { url: direct.url, headers: direct.headers }
}

/** 需要登录的资源在下载前确认会话有效；返回 false 让任务置为 login_expired */
export async function verifyAccess(deps: TaskResolverDeps, task: StoredTask): Promise<boolean> {
  if (!task.shareUrl) return true
  return deps.auth.hasSession()
}

function fileNameOfUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    const last = path.split('/').pop() ?? ''
    return decodeURIComponent(last) || 'download'
  } catch {
    return 'download'
  }
}
