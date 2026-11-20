/**
 * tvbox 直播源解析：lives 数组（url 外链 txt/m3u 或 groups 内联）→ 分组频道模型。
 * txt 格式（TVBox 约定）：
 *   分组名,#genre#
 *   频道名,http://a/1.m3u8#http://b/1.m3u8|User-Agent=xx&Referer=yy
 * m3u 格式：#EXTM3U / #EXTINF:-1 tvg-id="" group-title="央视",CCTV1 → 下一行 URL
 * 频道内单条 url 再用 $ 拆"地址$线路名"（与 TVBox switchLine 一致）。
 */
import { rawFetch } from './net'
import { asArray } from './shared'
import type { LiveChannel, LiveGroup } from './types'

export interface LiveSourceMeta {
  name: string
  /** 外链地址（txt/m3u/json 三种之一，按内容探测）；内联源为空 */
  url?: string
  epg?: string
  logo?: string
  ua?: string
  referer?: string
}

/** lives 数组归一（type 字段在生态里语义混乱，直接看 url/groups/api 有无） */
export function normalizeLiveSources(lives: unknown[]): LiveSourceMeta[] {
  const out: LiveSourceMeta[] = []
  for (const raw of asArray<any>(lives)) {
    if (!raw || typeof raw !== 'object') continue
    if (typeof raw.url === 'string' && raw.url) {
      out.push({
        name: String(raw.name ?? '直播'),
        url: raw.url,
        epg: typeof raw.epg === 'string' ? raw.epg : undefined,
        logo: typeof raw.logo === 'string' ? raw.logo : undefined,
        ua: typeof raw.ua === 'string' ? raw.ua : undefined,
        referer: typeof raw.referer === 'string' ? raw.referer : undefined,
      })
    } else if (Array.isArray(raw.groups)) {
      out.push({ name: String(raw.name ?? '直播') })
    }
    // api=spider 直播（liveContent）暂不支持，跳过
  }
  return out
}

function parseHeadersSuffix(rawUrl: string): { url: string; header?: Record<string, string> } {
  const pipeIdx = rawUrl.indexOf('|')
  if (pipeIdx < 0) return { url: rawUrl.trim() }
  const url = rawUrl.slice(0, pipeIdx).trim()
  const header: Record<string, string> = {}
  for (const pair of rawUrl.slice(pipeIdx + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    header[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return { url, header: Object.keys(header).length ? header : undefined }
}

/** 频道行：名称,url 或 名称,url#url2（多线路）；每条 url 可带 |header 后缀与 $线路名 */
function parseChannelLine(name: string, urlPart: string): LiveChannel | null {
  const urls: string[] = []
  let header: Record<string, string> | undefined
  for (const raw of urlPart.split('#')) {
    const { url, header: h } = parseHeadersSuffix(raw)
    if (!url) continue
    urls.push(url)
    if (h) header = { ...(header ?? {}), ...h }
  }
  if (!urls.length) return null
  return { name: name.trim(), urls, header }
}

/** txt（#genre# 分组）解析 */
export function parseLiveTxt(text: string): LiveGroup[] {
  const groups: LiveGroup[] = []
  let current: LiveGroup | null = null
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.trim()
    if (!line || line.startsWith('#') && !line.includes('#genre#')) continue
    if (line.includes('#genre#')) {
      const name = line.split(',')[0].trim()
      current = { name, channels: [] }
      groups.push(current)
      continue
    }
    const comma = line.indexOf(',')
    if (comma <= 0 || !current) continue
    const channel = parseChannelLine(line.slice(0, comma), line.slice(comma + 1))
    if (channel) current.channels.push(channel)
  }
  return groups.filter(g => g.channels.length)
}

/** m3u 解析（#EXTINF group-title/tvg-logo/tvg-id） */
export function parseLiveM3u(text: string): LiveGroup[] {
  const groupMap = new Map<string, LiveGroup>()
  let pending: { name: string; group: string; logo?: string; epg?: string } | null = null
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF')) {
      const name = line.includes(',') ? line.slice(line.lastIndexOf(',') + 1).trim() : ''
      const group = /group-title="([^"]*)"/.exec(line)?.[1] ?? '未分组'
      const logo = /tvg-logo="([^"]*)"/.exec(line)?.[1]
      const epg = /tvg-id="([^"]*)"/.exec(line)?.[1] ?? /tvg-name="([^"]*)"/.exec(line)?.[1]
      pending = { name, group, logo, epg }
      continue
    }
    if (line.startsWith('#')) continue
    if (!pending) continue
    const channel = parseChannelLine(pending.name, line)
    if (channel) {
      channel.logo = channel.logo ?? pending.logo
      channel.epg = channel.epg ?? pending.epg
      let g = groupMap.get(pending.group)
      if (!g) { g = { name: pending.group, channels: [] }; groupMap.set(pending.group, g) }
      g.channels.push(channel)
    }
    pending = null
  }
  return [...groupMap.values()].filter(g => g.channels.length)
}

/** 内联 groups（FongMi Live bean）解析 */
export function parseLiveGroupsInline(groups: unknown): LiveGroup[] {
  return asArray<any>(groups).map(g => ({
    name: String(g?.name ?? ''),
    channels: asArray<any>(g?.channel).map(ch => {
      const urls: string[] = []
      for (const raw of asArray<any>(ch?.urls)) {
        // url 形态 "http://...$线路名"
        const rawStr = String(raw ?? '')
        const dollar = rawStr.indexOf('$')
        urls.push(dollar > 0 ? rawStr.slice(0, dollar) : rawStr)
      }
      return {
        name: String(ch?.name ?? ''),
        urls: urls.filter(Boolean),
        number: ch?.number ? Number(ch.number) : undefined,
        logo: ch?.logo ? String(ch.logo) : undefined,
        epg: ch?.epg ? String(ch.epg) : undefined,
        header: ch?.header && typeof ch.header === 'object'
          ? Object.fromEntries(Object.entries(ch.header).map(([k, v]) => [k, String(v)])) : undefined,
      } as LiveChannel
    }).filter(ch => ch.name && ch.urls.length),
  })).filter(g => g.name && g.channels.length)
}

/** 拉取直播源内容并按内容形态解析 */
export async function loadLiveSource(source: LiveSourceMeta, ownerKey: string): Promise<LiveGroup[]> {
  if (!source.url) throw new Error('直播源缺少地址')
  const headers: Record<string, string> = {}
  if (source.ua) headers['user-agent'] = source.ua
  if (source.referer) headers.referer = source.referer
  const res = await rawFetch(source.url, { headers, ownerKey, timeoutMs: 20_000 })
  if (res.status >= 400) throw new Error(`直播源拉取失败 HTTP ${res.status}`)
  const text = res.body
  if (text.trimStart().startsWith('{')) {
    // JSON 直播源 {group: {channel: [urls]}}（部分源用）
    try {
      const json = JSON.parse(text)
      const groups: LiveGroup[] = []
      for (const [gname, channels] of Object.entries(json?.groups ?? json ?? {})) {
        if (!channels || typeof channels !== 'object') continue
        const list: LiveChannel[] = []
        for (const [cname, urls] of Object.entries(channels as Record<string, unknown>)) {
          const u = Array.isArray(urls) ? urls.map(String) : [String(urls)]
          if (cname && u.length) list.push({ name: cname, urls: u.filter(Boolean) })
        }
        if (list.length) groups.push({ name: gname, channels: list })
      }
      if (groups.length) return groups
    } catch { /* fallthrough to text */ }
  }
  if (/^#EXTM3U/i.test(text.trim())) return parseLiveM3u(text)
  return parseLiveTxt(text)
}
