/**
 * tvbox 网盘源（OpenList/AList 协议）：TVBox 生态的网盘资源标准形态是
 * type4 站点 ext 指向 OpenList 挂载点，或直接添加 OpenList 站点做搜索源。
 *
 * 本模块实现 OpenList/AList 的最小客户端：
 *  - 探测 /api/public/settings（无需登录）确认可用
 *  - 扫码登录：POST /api/auth/qr （部分版本）或退化为用户名密码 token；
 *    主流部署用 token（设置 → 其他 → 令牌）。扫码场景走 /@manage 二维码页面 URL，
 *    用户在浏览器完成登录后回填 token —— 桌面端最稳路径是「打开登录页 + 粘贴 token」。
 *  - 搜索：/api/fs/search（需要 token；Default: true 的搜索必须鉴权）
 *  - 详情/播放：/api/fs/get 拿 raw_url 直链（网盘直链多为 302 → CDN，代理转发即可）
 *
 * 记录（storage KV `openlist.accounts`）：{ id, name, url, token, addedAt }
 * 401 过期：调用方捕获 401 后标记 expired，前端弹重新登录。
 */
import { fetchJson } from './net'
import type { VodItem } from './types'

export interface OpenListAccount {
  id: string
  name: string
  url: string
  token: string
  addedAt: number
}

export interface OpenListFile {
  name: string
  size: number
  isDir: boolean
  modified?: string
  rawUrl?: string
  sign?: string
  parentPath: string
}

/** 探测 OpenList 站点（无需登录的公开设置接口） */
export async function probeOpenList(url: string): Promise<{ ok: boolean; version?: string; title?: string }> {
  const base = url.replace(/\/+$/, '')
  const settings = await fetchJson<any>(`${base}/api/public/settings`, { timeoutMs: 10_000 }).catch(() => null)
  if (!settings || Number(settings.code) !== 200) return { ok: false }
  const data = settings.data ?? {}
  return { ok: true, version: String(data.version ?? ''), title: String(data.title ?? 'OpenList') }
}

/** 验证 token（/api/me） */
export async function verifyToken(url: string, token: string): Promise<{ ok: boolean; username?: string; expired?: boolean }> {
  const base = url.replace(/\/+$/, '')
  const res = await fetchJson<any>(`${base}/api/me`, {
    headers: { authorization: token },
    timeoutMs: 10_000,
  }).catch((e: Error) => e)
  if (res instanceof Error) return { ok: false, expired: false }
  if (Number(res.code) === 401) return { ok: false, expired: true }
  return { ok: Number(res.code) === 200, username: String(res.data?.username ?? '') }
}

/** 登录页地址（用户浏览器打开拿 token 的引导页） */
export function loginPageUrl(url: string): string {
  const base = url.replace(/\/+$/, '')
  return `${base}/@manage`
}

/** 搜索网盘文件（/api/fs/search；需要 token）。parent 可选限定目录。 */
export async function searchFiles(url: string, token: string, keyword: string, page = 1, perPage = 20): Promise<{ items: OpenListFile[]; total: number }> {
  const base = url.replace(/\/+$/, '')
  const res = await fetchJson<any>(`${base}/api/fs/search`, {
    method: 'POST',
    headers: { authorization: token, 'content-type': 'application/json' },
    data: { parent: '/', keywords: keyword, page, per_page: perPage, scope: 0, box: false },
    timeoutMs: 20_000,
  }).catch((e: Error) => e)
  if (res instanceof Error) throw new Error(`网盘搜索失败：${res.message}`)
  if (Number(res.code) === 401) { const err = new Error('网盘登录已过期（401），请重新授权'); (err as Error & { expired?: boolean }).expired = true; throw err }
  if (Number(res.code) !== 200) throw new Error(`网盘搜索失败：${String(res.message ?? res.code)}`)
  const content = res.data?.content ?? []
  return {
    items: content.map((f: any) => ({
      name: String(f.name ?? ''),
      size: Number(f.size ?? 0),
      isDir: Boolean(f.is_dir),
      parentPath: String(f.parent ?? ''),
      sign: f.sign ? String(f.sign) : undefined,
    })),
    total: Number(res.data?.total ?? content.length),
  }
}

/** 列目录（/api/fs/list） */
export async function listFiles(url: string, token: string, path: string, page = 1, perPage = 50): Promise<{ items: OpenListFile[]; total: number }> {
  const base = url.replace(/\/+$/, '')
  const res = await fetchJson<any>(`${base}/api/fs/list`, {
    method: 'POST',
    headers: { authorization: token, 'content-type': 'application/json' },
    data: { path, page, per_page: perPage, refresh: false },
    timeoutMs: 20_000,
  }).catch((e: Error) => e)
  if (res instanceof Error) throw new Error(`网盘目录读取失败：${res.message}`)
  if (Number(res.code) === 401) { const err = new Error('网盘登录已过期（401），请重新授权'); (err as Error & { expired?: boolean }).expired = true; throw err }
  if (Number(res.code) !== 200) throw new Error(`网盘目录读取失败：${String(res.message ?? res.code)}`)
  const content = res.data?.content ?? []
  return {
    items: content.map((f: any) => ({
      name: String(f.name ?? ''),
      size: Number(f.size ?? 0),
      isDir: Boolean(f.is_dir),
      modified: f.modified ? String(f.modified) : undefined,
      sign: f.sign ? String(f.sign) : undefined,
      parentPath: path,
    })),
    total: Number(res.data?.total ?? content.length),
  }
}

/** 取文件直链（/api/fs/get → raw_url）。视频文件直接可播（302 到网盘 CDN）。 */
export async function getFileRawUrl(url: string, token: string, path: string): Promise<string> {
  const base = url.replace(/\/+$/, '')
  const res = await fetchJson<any>(`${base}/api/fs/get`, {
    method: 'POST',
    headers: { authorization: token, 'content-type': 'application/json' },
    data: { path, password: '' },
    timeoutMs: 20_000,
  }).catch((e: Error) => e)
  if (res instanceof Error) throw new Error(`网盘文件读取失败：${res.message}`)
  if (Number(res.code) === 401) { const err = new Error('网盘登录已过期（401），请重新授权'); (err as Error & { expired?: boolean }).expired = true; throw err }
  if (Number(res.code) !== 200) throw new Error(`网盘文件读取失败：${String(res.message ?? res.code)}`)
  const raw = res.data?.raw_url
  if (!raw) throw new Error('该文件不是直链可播类型（可能是目录）')
  return String(raw)
}

/** OpenList 文件 → 影片卡片（目录=可进详情的"片"，视频文件=选集） */
export function fileToVodItem(f: OpenListFile, accountId: string): VodItem {
  return {
    vod_id: f.isDir ? `dir:${f.parentPath === '/' ? '' : f.parentPath}/${f.name}` : `file:${f.sign ?? ''}:${f.parentPath === '/' ? '' : f.parentPath}/${f.name}`,
    vod_name: f.name.replace(/\.(mp4|mkv|ts|avi|mov|flv|wmv|m3u8|iso|rmvb)$/i, ''),
    vod_pic: undefined,
    vod_remarks: f.isDir ? '目录' : formatSize(f.size),
    siteKey: `openlist:${accountId}`,
  }
}

export function formatSize(bytes: number): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${units[i]}`
}

/** 视频文件判定（选集过滤用） */
export function isVideoFile(name: string): boolean {
  return /\.(mp4|mkv|ts|avi|mov|flv|wmv|m3u8|iso|rmvb|mpg|mpe|3gp|asf)$/i.test(name)
}
