/**
 * 天翼云分享解析（无需登录）与直链解析（需登录）。
 * 分享链接形如 https://cloud.189.cn/t/{短码} 或短码本身；?pwd= 是提取码。
 */

import { getAdapter } from '../adapters/current.ts'
import { BackendError, type RawResponse } from '../adapters/types.ts'
import { CookieJar, jarRequestJson } from './http.ts'
import { downloadSignature, noCacheParam, ssoAccessToken, timestampSeconds } from './sign.ts'

const SHARE_API = 'https://cloud.189.cn/api/open/share'

export interface ShareFile {
  /** 文件 id（下载时用） */
  id: string
  name: string
  /** 字节；未知 0 */
  size: number
  md5: string
  createDate: string
  /** 天翼云媒体类型（数字），未知 -1 */
  mediaType: number
}

export interface ShareFolder {
  id: string
  name: string
}

export interface ParsedShare {
  title: string
  /** 数字分享 id */
  shareId: string
  /** 分享根是单文件时 files 只有一个且 folders 为空 */
  files: ShareFile[]
  folders: ShareFolder[]
  /** 原始短码 */
  shareCode: string
  /** 提取码（可能为空） */
  accessCode: string
  /** 根是单文件时为 true */
  singleFile: boolean
}

export interface ShareListResult {
  files: ShareFile[]
  folders: ShareFolder[]
  /** 分页游标：第 2 页起 count 0 表示取完 */
  count: number
}

/** 解析分享链接：返回短码与提取码 */
export function parseShareCode(url: string): { shareCode: string; pwd: string } {
  const text = String(url ?? '').trim()
  if (!text) throw new BackendError('INVALID_ARGUMENT', '分享链接不能为空')
  // 完整链接（或含短码的任意文本）
  const full = /cloud\.189\.cn\/t\/([^/?#]+)(?:\?pwd=([^&#]+))?/.exec(text)
  if (full) return { shareCode: full[1], pwd: full[2] ? decodeURIComponent(full[2]) : '' }
  // 短码形式：纯字母数字
  if (/^[A-Za-z0-9]+$/.test(text)) {
    const pwdMatch = /[?&]pwd=([^&#]+)/.exec(text)
    return { shareCode: text, pwd: pwdMatch ? decodeURIComponent(pwdMatch[1]) : '' }
  }
  throw new BackendError('INVALID_ARGUMENT', '无法解析分享链接')
}

interface ShareIdResponse { res_code?: number; shareId?: unknown }
interface ShareInfoResponse { fileId?: unknown; isFolder?: unknown; fileName?: unknown; fileSize?: unknown; md5?: unknown; needAccessCode?: unknown }

function asString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

async function checkAccessCode(jar: CookieJar, shareCode: string, accessCode: string): Promise<string> {
  const { data } = await jarRequestJson<ShareIdResponse>(jar, {
    url: `${SHARE_API}/checkAccessCode.action?noCache=${noCacheParam()}&shareCode=${encodeURIComponent(shareCode)}&accessCode=${encodeURIComponent(accessCode)}`,
    headers: { accept: 'application/json;charset=UTF-8' },
  })
  const shareId = asString(data.shareId)
  if (!shareId) {
    const raw = asString((data as unknown as { res_msg?: unknown }).res_msg ?? '')
    if (/访问码|提取码|accessCode/i.test(raw) || data.res_code === 1 || data.res_code === -1) {
      throw new BackendError('SHARE_CODE_WRONG', '提取码错误或分享已失效')
    }
    throw new BackendError('SHARE_ERROR', '获取分享信息失败，分享可能已失效')
  }
  return shareId
}

async function fetchShareInfo(jar: CookieJar, shareCode: string): Promise<ShareInfoResponse> {
  const { data } = await jarRequestJson<ShareInfoResponse>(jar, {
    url: `${SHARE_API}/getShareInfoByCodeV2.action?noCache=${noCacheParam()}&shareCode=${encodeURIComponent(shareCode)}`,
    headers: { accept: 'application/json;charset=UTF-8' },
  })
  return data
}

function mapFileEntry(entry: Record<string, unknown>): ShareFile {
  return {
    id: asString(entry.id),
    name: asString(entry.name),
    size: asNumber(entry.size),
    md5: asString(entry.md5),
    createDate: asString(entry.createDate),
    mediaType: entry.mediaType === undefined ? -1 : asNumber(entry.mediaType),
  }
}

function mapFolderEntry(entry: Record<string, unknown>): ShareFolder {
  return { id: asString(entry.id), name: asString(entry.name) }
}

/** 列出分享文件夹的一页（源行为：pageSize 60，按 lastOpTime 降序） */
export async function listShareFolderPage(jar: CookieJar, shareId: string, folderId: string, accessCode: string, pageNum: number): Promise<ShareListResult> {
  const { data } = await jarRequestJson<{ fileListAO?: { fileList?: unknown; folderList?: unknown; count?: unknown } }>(jar, {
    url:
      `${SHARE_API}/listShareDir.action?noCache=${noCacheParam()}&pageNum=${pageNum}&pageSize=60` +
      `&fileId=${encodeURIComponent(shareId)}&shareDirFileId=${encodeURIComponent(folderId)}&isFolder=true&shareId=${encodeURIComponent(shareId)}` +
      `&shareMode=1&iconOption=5&orderBy=lastOpTime&descending=true&accessCode=${encodeURIComponent(accessCode)}`,
    headers: { accept: 'application/json;charset=UTF-8', 'sign-type': '1' },
  })
  const area = data.fileListAO ?? {}
  const files = Array.isArray(area.fileList) ? (area.fileList as Record<string, unknown>[]).map(mapFileEntry) : []
  const folders = Array.isArray(area.folderList) ? (area.folderList as Record<string, unknown>[]).map(mapFolderEntry) : []
  return { files, folders, count: asNumber(area.count) }
}

/** 逐页取完文件夹内容（第 2 页起 count:0 即停） */
export async function listShareFolder(jar: CookieJar, shareId: string, folderId: string, accessCode: string): Promise<ShareListResult> {
  const files: ShareFile[] = []
  const folders: ShareFolder[] = []
  let count = 0
  for (let page = 1; page <= 50; page++) {
    const result = await listShareFolderPage(jar, shareId, folderId, accessCode, page)
    files.push(...result.files)
    folders.push(...result.folders)
    count = result.count
    // 第 1 页按返回条数判断；之后 count 0 表示取完。
    if (page > 1 && (result.files.length === 0 && result.folders.length === 0)) break
    if (files.length + folders.length >= count) break
    if (result.files.length === 0 && result.folders.length === 0) break
  }
  return { files, folders, count }
}

/**
 * 解析分享（无需登录）。文件夹分页取完（只取根一层，子文件夹在 folders 里由前端逐级展开）。
 */
export async function parseShare(url: string, accessCode: string): Promise<ParsedShare> {
  const { shareCode, pwd } = parseShareCode(url)
  const code = accessCode.trim() || pwd
  const jar = new CookieJar()
  const shareId = await checkAccessCode(jar, shareCode, code)
  const info = await fetchShareInfo(jar, shareCode)
  const isFolder = asBool(info.isFolder)
  if (!isFolder) {
    return {
      title: asString(info.fileName) || shareCode,
      shareId,
      files: [{
        id: asString(info.fileId),
        name: asString(info.fileName),
        size: asNumber(info.fileSize),
        md5: asString(info.md5),
        createDate: '',
        mediaType: -1,
      }],
      folders: [],
      shareCode,
      accessCode: code,
      singleFile: true,
    }
  }
  const listed = await listShareFolder(jar, shareId, shareId, code)
  const first = await listShareFolderPage(jar, shareId, shareId, code, 1)
  void first
  return {
    title: asString((info as unknown as { fileName?: unknown }).fileName) || shareCode,
    shareId,
    files: listed.files,
    folders: listed.folders,
    shareCode,
    accessCode: code,
    singleFile: false,
  }
}

export interface DownloadUrlResult {
  url: string
  fileName: string
  size: number
  headers: Record<string, string>
}

/** 解析直链（需登录）：ssoH5 换 accessToken，再 getFileDownloadUrl 带签名头 */
export async function resolveFileDownloadUrl(credentialCookie: string, shareId: string, fileId: string): Promise<DownloadUrlResult> {
  if (!credentialCookie) throw new BackendError('LOGIN_REQUIRED', '天翼云登录已过期，请重新登录')
  const jar = new CookieJar()
  for (const pair of credentialCookie.split('; ')) {
    if (pair.includes('=')) jar.store(`${pair}; Path=/`, 'https://cloud.189.cn/')
  }
  const accessToken = await ssoAccessToken(jar)
  const timestamp = timestampSeconds()
  const signature = downloadSignature(accessToken, timestamp, fileId, shareId)
  const adapter = getAdapter()
  void adapter
  const { data } = await jarRequestJson<{ fileDownloadUrl?: unknown; fileName?: unknown; fileSize?: unknown }>(jar, {
    url: `https://api.cloud.189.cn/open/file/getFileDownloadUrl.action?fileId=${encodeURIComponent(fileId)}&dt=1&shareId=${encodeURIComponent(shareId)}`,
    headers: {
      cookie: jar.header(),
      accesstoken: accessToken,
      signature,
      timestamp,
      'sign-type': '1',
      accept: 'application/json;charset=UTF-8',
    },
    maxHops: 1,
  })
  const url = asString(data.fileDownloadUrl)
  if (!url) throw new BackendError('LOGIN_REQUIRED', '天翼云登录已过期，请重新登录')
  return {
    url,
    fileName: asString(data.fileName),
    size: asNumber(data.fileSize),
    headers: { cookie: jar.header(), referer: 'https://cloud.189.cn/' },
  }
}

/** 仅在需要手动构造 RawResponse 的调用方提供便利（保持导出对称） */
export function emptyResponse(): RawResponse {
  return { status: 200, headers: {}, setCookies: [], location: '', body: new Uint8Array() }
}
