/**
 * 修改器数据源（fucnm）：
 * - index.txt（{total,page,pagesize}）+ list_{n}.txt（每页 50，共 37 页），并发 6 拉取后缓存内存；
 * - 排序列表 xgqlist/list_{sort}.txt（5 综合、1 最新、2 最热、3 推荐）；
 * - 排序/搜索/分页在后端本地完成（搜索匹配 keyw、en_name、title，不区分大小写，每页 50）；
 * - u_name / ss_name 是 AES 加密的下载直链 / 配置 URL；
 * - 攻略接口 POST /sapi/getxgqgl，表单 xgq_id,time,nonce,sign。
 */

import { getAdapter } from '../adapters/current.ts'
import { BackendError } from '../adapters/types.ts'
import { aesDecrypt, fucnmSign, generateNonce, timestampFromSeconds } from '../crypto.ts'
import type { DetailData, LibraryItem, Page, ResourcePackage, TrainerGuide, TrainerOption } from '../contracts.ts'
import { Semaphore, asArray, asRecord, text } from '../util.ts'
import type { SourceAdapter, SourceFacets } from './registry.ts'
import { itemIdOf, siteIdOf } from './registry.ts'

const BASE = 'https://dl.fucnm.com'
const PAGE_SIZE = 50

const SORTS = [
  { id: '', label: '综合' },
  { id: '1', label: '最新' },
  { id: '2', label: '最热' },
  { id: '3', label: '推荐' },
]

interface TrainerRecord extends Record<string, unknown> {
  id: number
  title: string
  en_name: string
  keyw: string
  litpic: string
  version: string
  support_ver: string
  bits: string
  u_name: string
  ss_name: string
  down_total: number
  pubdate_at: string
  body: string
}

const cache: { all: TrainerRecord[] | null; loading: Promise<TrainerRecord[]> | null } = { all: null, loading: null }

/** 清空内存缓存（进程内重载或单测时用） */
export function resetTrainerCache(): void {
  cache.all = null
  cache.loading = null
}

async function fetchJson(url: string): Promise<unknown> {
  const adapter = getAdapter()
  const response = await adapter.request({ url, headers: { accept: 'application/json,text/plain,*/*' }, timeoutMs: 20_000 })
  if (response.status !== 200) throw new BackendError('SOURCE_ERROR', '修改器站点接口暂时不可用')
  return JSON.parse(new TextDecoder('utf-8').decode(response.body))
}

async function loadAllTrainers(): Promise<TrainerRecord[]> {
  if (cache.all) return cache.all
  if (!cache.loading) {
    cache.loading = (async () => {
      const index = await fetchJson(`${BASE}/datafile/xgqdetail/index.txt`) as { total?: unknown; page?: unknown; pagesize?: unknown }
      const pages = Math.max(1, Number(index.page) || 1)
      const semaphore = new Semaphore(6)
      const results: TrainerRecord[] = []
      const errors: unknown[] = []
      const tasks: Array<Promise<void>> = []
      for (let page = 1; page <= pages; page++) {
        tasks.push((async () => {
          const release = await semaphore.acquire()
          try {
            const list = await fetchJson(`${BASE}/datafile/xgqdetail/list_${page}.txt`)
            for (const entry of asArray(list)) {
              const record = asRecord(entry)
              if (record) results.push(record as unknown as TrainerRecord)
            }
          } catch (error) {
            errors.push(error)
          } finally {
            release()
          }
        })())
      }
      await Promise.all(tasks)
      if (results.length === 0 && errors.length > 0) throw errors[0]
      results.sort((left, right) => Number(left.id) - Number(right.id))
      cache.all = results
      return results
    })()
    cache.loading.finally(() => { cache.loading = null })
  }
  return cache.loading
}

async function loadSortList(sort: string): Promise<number[]> {
  const list = await fetchJson(`${BASE}/datafile/xgqlist/list_${sort}.txt`)
  return asArray(list).map(entry => Number(entry)).filter(Number.isFinite)
}

function toItem(record: TrainerRecord): LibraryItem {
  const cover = text(record.litpic)
  const meta: string[] = []
  if (text(record.version)) meta.push(`版本 ${text(record.version)}`)
  if (text(record.support_ver)) meta.push(`支持 ${text(record.support_ver)}`)
  if (text(record.bits)) meta.push(text(record.bits))
  return {
    id: itemIdOf('trainer', 'trainer', String(record.id)),
    kind: 'trainer',
    section: 'trainer',
    source: 'fucnm',
    sourceId: String(record.id),
    title: text(record.title),
    subtitle: text(record.en_name),
    cover,
    coverToken: cover ? `img:${Buffer.from(cover, 'utf8').toString('base64url')}` : '',
    category: text(record.keyw).split(/[+,，\s]+/).filter(Boolean).slice(0, 4).join('、'),
    sizeText: '',
    meta,
    favorite: false,
    installed: false,
  }
}

function matches(record: TrainerRecord, keyword: string): boolean {
  const lower = keyword.toLowerCase()
  return (
    text(record.keyw).toLowerCase().includes(lower) ||
    text(record.en_name).toLowerCase().includes(lower) ||
    text(record.title).toLowerCase().includes(lower)
  )
}

function decryptOrEmpty(value: unknown): string {
  const raw = text(value)
  if (!raw) return ''
  try {
    return aesDecrypt(raw)
  } catch {
    return ''
  }
}

function fetchGuides(trainerId: number): Promise<TrainerGuide[]> {
  return (async () => {
    const adapter = getAdapter()
    const time = timestampFromSeconds()
    const nonce = generateNonce()
    const sign = fucnmSign(time, nonce, 'getxgqgl')
    const response = await adapter.request({
      url: `${BASE}/sapi/getxgqgl`,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `xgq_id=${trainerId}&time=${time}&nonce=${nonce}&sign=${sign}`,
      timeoutMs: 20_000,
    })
    if (response.status !== 200) return []
    const data = JSON.parse(new TextDecoder('utf-8').decode(response.body)) as Record<string, unknown>
    return asArray(data.data ?? data.list)
      .map(entry => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map(entry => ({ id: Number(entry.id) || 0, title: text(entry.title), url: text(entry.url) }))
      .filter(entry => entry.title || entry.url)
  })().catch(() => [])
}

function parseOptions(body: unknown): TrainerOption[] {
  return asArray(body)
    .map(entry => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map(entry => ({
      name: text(entry.name),
      hotkey: text(entry.hotkey),
      type: Number(entry.type) || 0,
      text: text(entry.text),
      tooltip: text(entry.tips) || text(entry.tooltip),
    }))
    .filter(entry => entry.name)
}

export function trainerSource(): SourceAdapter {
  const facets = (_section: string): SourceFacets => ({ categories: [{ id: '', label: '全部分类' }], sorts: SORTS })

  // 站点 id 是裸数字，条目 id 带前缀（trainer:trainer:站点id），这里剥掉再查
  const loadRecord = async (itemId: string): Promise<TrainerRecord | null> => {
    const siteId = siteIdOf(itemId)
    const all = await loadAllTrainers()
    return all.find(entry => String(entry.id) === siteId) ?? null
  }

  return {
    kind: 'trainer',
    label: '修改器',
    facets,

    async list(query): Promise<Page<LibraryItem>> {
      const all = await loadAllTrainers()
      let records: TrainerRecord[]
      if (query.sort) {
        // 排序列表给 id 顺序，按它重排。
        const orderIds = await loadSortList(query.sort)
        const order = new Map(orderIds.map((id, index) => [id, index]))
        records = [...all].sort((left, right) => (order.get(Number(left.id)) ?? Number.MAX_SAFE_INTEGER) - (order.get(Number(right.id)) ?? Number.MAX_SAFE_INTEGER))
      } else {
        records = all
      }
      if (query.keyword) records = records.filter(record => matches(record, query.keyword))
      const total = records.length
      const start = (query.page - 1) * PAGE_SIZE
      const items = records.slice(start, start + PAGE_SIZE).map(toItem)
      return { items, page: query.page, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total }
    },

    async detail(itemId): Promise<DetailData> {
      const record = await loadRecord(itemId)
      if (!record) throw new BackendError('NOT_FOUND', '修改器不存在或已下架')
      const downloadUrl = decryptOrEmpty(record.u_name)
      const configUrl = decryptOrEmpty(record.ss_name)
      const guides = await fetchGuides(Number(record.id))
      let options: TrainerOption[] = []
      if (configUrl) {
        try {
          const config = await fetchJson(configUrl)
          options = parseOptions(config)
        } catch {
          options = []
        }
      }
      const cover = text(record.litpic)
      const item: LibraryItem = {
        ...toItem(record),
        coverToken: cover ? `img:${Buffer.from(cover, 'utf8').toString('base64url')}` : '',
      }
      // 包 id 就是解密后的下载直链，任务模块直接拿去下载
      const packages = downloadUrl ? [trainerPackage(record, downloadUrl)] : []
      return {
        item,
        media: cover ? [{ token: `img:${Buffer.from(cover, 'utf8').toString('base64url')}`, type: 'image' }] : [],
        description: text(record.body),
        datetime: text(record.pubdate_at),
        sizeText: '',
        installedSizeText: '',
        minConfig: '',
        recommendConfig: '',
        officialUrl: '',
        packages,
        trainerOptions: options,
        trainerGuides: guides,
      }
    },

    async fileList(itemId): Promise<ResourcePackage[]> {
      const record = await loadRecord(itemId)
      if (!record) return []
      const downloadUrl = decryptOrEmpty(record.u_name)
      if (!downloadUrl) return []
      return [trainerPackage(record, downloadUrl)]
    },
  }
}

/** 修改器的直链包：id 是解密后的下载 URL */
function trainerPackage(record: TrainerRecord, downloadUrl: string): ResourcePackage {
  return {
    id: downloadUrl,
    name: downloadUrl.split('/').pop() || text(record.title),
    sizeText: '',
    size: 0,
    provider: '直链下载',
    state: 'ready',
    exePath: '',
    updatedAt: text(record.pubdate_at),
  }
}

export { decryptOrEmpty as decryptTrainerUrl }
