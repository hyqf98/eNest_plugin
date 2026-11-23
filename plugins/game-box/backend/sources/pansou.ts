/**
 * 网盘聚合搜索（PanSou）。默认 base https://so.252035.xyz，可在设置里改。
 * GET /api/health → {status, channels, plugin_count}
 * POST /api/search {kw,res:"merge",src:"all",cloud_types:[…]} → {code,message,data:{total,merged_by_type}}
 */

import { getAdapter } from '../adapters/current.ts'
import { BackendError } from '../adapters/types.ts'
import type { PanSouGroup, PanSouResponse, PanSouResult } from '../contracts.ts'
import { asArray, asRecord, text } from '../util.ts'

export const DEFAULT_PANSOU_BASE = 'https://so.252035.xyz'

/** 云盘类型展示名 */
const TYPE_LABELS: Record<string, string> = {
  tianyi: '天翼云盘',
  ali: '阿里云盘',
  quark: '夸克网盘',
  baidu: '百度网盘',
  uc: 'UC 网盘',
  mobile: '移动云盘',
  115: '115 网盘',
  123: '123 网盘',
  pikpak: 'PikPak',
  magnet: '磁力',
  others: '其他',
}

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

function normalizeBase(baseUrl: string): string {
  const base = (baseUrl || DEFAULT_PANSOU_BASE).trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) throw new BackendError('INVALID_ARGUMENT', '网盘搜索地址必须是 http(s) 链接')
  return base
}

export interface PanSouHealth {
  available: boolean
  baseUrl: string
  channels: string[]
  pluginCount: number
}

export async function health(baseUrl: string): Promise<PanSouHealth> {
  const base = normalizeBase(baseUrl)
  const adapter = getAdapter()
  const response = await adapter.request({ url: `${base}/api/health`, headers: { accept: 'application/json' }, timeoutMs: 10_000 })
  if (response.status !== 200) throw new BackendError('SOURCE_ERROR', `网盘搜索服务不可用（HTTP ${response.status}）`)
  const data = JSON.parse(new TextDecoder('utf-8').decode(response.body)) as Record<string, unknown>
  return {
    available: text(data.status) === 'ok',
    baseUrl: base,
    channels: asArray(data.channels).map(entry => text(entry)),
    pluginCount: Number(data.plugin_count) || 0,
  }
}

/** 网盘搜索入口（registry 用）：SearchAdapter 形状 */
export function pansouSource(): import('./registry.ts').SourceAdapter {
  return {
    kind: 'pansou',
    label: '网盘搜索',
    facets(_section) {
      return { categories: [], sorts: [] }
    },
    // pansou 不是浏览源：list/detail/fileList 不可用，统一走 pansou.ts 的 search。
    async list() {
      throw new BackendError('INVALID_ARGUMENT', '网盘搜索不支持浏览列表')
    },
    async detail() {
      throw new BackendError('INVALID_ARGUMENT', '网盘搜索不支持详情')
    },
    async fileList() {
      return []
    },
  }
}

export async function search(keyword: string, cloudTypes: string[], baseUrl: string): Promise<PanSouResponse> {
  if (!keyword.trim()) throw new BackendError('INVALID_ARGUMENT', '请输入搜索关键词')
  const base = normalizeBase(baseUrl)
  const adapter = getAdapter()
  const types = cloudTypes.length ? cloudTypes : ['quark', 'tianyi']
  const response = await adapter.request({
    url: `${base}/api/search`,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ kw: keyword, res: 'merge', src: 'all', cloud_types: types }),
    timeoutMs: 45_000,
  })
  if (response.status !== 200) throw new BackendError('SOURCE_ERROR', `网盘搜索失败（HTTP ${response.status}）`)
  const payload = JSON.parse(new TextDecoder('utf-8').decode(response.body)) as Record<string, unknown>
  if (Number(payload.code) !== 0) {
    throw new BackendError('SOURCE_ERROR', `网盘搜索失败：${text(payload.message, '未知错误')}`)
  }
  const data = asRecord(payload.data) ?? {}
  const merged = asRecord(data.merged_by_type) ?? {}
  const groups: PanSouGroup[] = []
  let total = 0
  for (const [type, entries] of Object.entries(merged)) {
    const results: PanSouResult[] = asArray(entries)
      .map(entry => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map(entry => ({
        url: text(entry.url),
        accessCode: text(entry.password),
        note: text(entry.note),
        datetime: text(entry.datetime),
        source: text(entry.source),
        downloadable: type === 'tianyi',
      }))
      .filter(entry => entry.url)
    if (results.length === 0) continue
    total += results.length
    groups.push({ type, label: typeLabel(type), results })
  }
  // 天翼分组放最前（可一键下载）。
  groups.sort((left, right) => (left.type === 'tianyi' ? -1 : right.type === 'tianyi' ? 1 : 0))
  return { total: Number(data.total) || total, groups }
}
