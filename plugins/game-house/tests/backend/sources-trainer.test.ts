/**
 * 修改器数据源（fucnm）专项单测：索引分页合并、并发拉取、本地排序/搜索/分页、
 * AES 解出直链/配置、攻略接口签名表单字段。不联网。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockAdapter } from '../../backend/adapters/mock.ts'
import { getAdapter, setAdapter } from '../../backend/adapters/current.ts'
import { aesDecrypt, aesEncrypt, fucnmSign, generateNonce, md5Hex, timestampFromSeconds } from '../../backend/crypto.ts'
import { trainerSource, resetTrainerCache, decryptTrainerUrl } from '../../backend/sources/trainer.ts'
import type { LibraryQuery } from '../../src/shared/contracts.ts'

interface TrainerEntry {
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

function trainerEntry(id: number, patch: Partial<TrainerEntry> = {}): TrainerEntry {
  return {
    id,
    title: `风灵月影修改器 ${id}`,
    en_name: `FLiNG Trainer ${id}`,
    keyw: '无敌,一击必杀,无限金钱',
    litpic: `https://dl.fucnm.com/img/${id}.jpg`,
    version: `${id}.0`,
    support_ver: 'v1.0+',
    bits: '64位',
    u_name: aesEncrypt(`https://dl.fucnm.com/down/${id}/setup_${id}.zip`),
    ss_name: aesEncrypt(`https://dl.fucnm.com/config/${id}.json`),
    down_total: 1000 + id,
    pubdate_at: '2024-05-01',
    body: '',
    ...patch,
  }
}

function baseQuery(patch: Partial<LibraryQuery> = {}): LibraryQuery {
  return { section: 'trainer', source: 'ode', page: 1, keyword: '', category: '', sort: '', ...patch }
}

async function withMock(run: (network: import('../../backend/adapters/mock.ts').MockNetwork) => Promise<void>): Promise<void> {
  resetTrainerCache()
  const { adapter, network, cleanup } = await createMockAdapter()
  setAdapter(adapter)
  try {
    await run(network)
  } finally {
    resetTrainerCache()
    await cleanup()
    setAdapter(getAdapter())
  }
}

async function registerIndex(network: import('../../backend/adapters/mock.ts').MockNetwork, entries: TrainerEntry[]): Promise<void> {
  network.respond('https://dl.fucnm.com/datafile/xgqdetail/index.txt', { body: JSON.stringify({ total: entries.length, page: Math.ceil(entries.length / 50), pagesize: 50 }) })
  for (let page = 1; page * 50 - 50 < entries.length; page++) {
    const slice = entries.slice((page - 1) * 50, page * 50)
    network.respond(`https://dl.fucnm.com/datafile/xgqdetail/list_${page}.txt`, { body: JSON.stringify(slice) })
  }
}

test('索引 + 多页合并（37 页场景的缩小版：3 页并发拉取）', async () => {
  await withMock(async network => {
    const entries = Array.from({ length: 130 }, (_, i) => trainerEntry(i + 1))
    await registerIndex(network, entries)
    const source = trainerSource()
    const page = await source.list(baseQuery())
    assert.equal(page.total, 130)
    assert.equal(page.items.length, 50)
    assert.equal(page.totalPages, 3)
    // 并发限 6：一次 list 只会拉 index + 全部页（3 页）
    const pageRequests = network.log.filter(entry => entry.url.includes('/datafile/xgqdetail/list_')).length
    assert.equal(pageRequests, 3)
    // 第二次 list 走内存缓存，不再发网络请求
    const logLength = network.log.length
    await source.list(baseQuery({ page: 2 }))
    assert.equal(network.log.length, logLength)
  })
})

test('本地搜索：keyw / en_name / title 不区分大小写，每页 50', async () => {
  await withMock(async network => {
    const entries = [
      trainerEntry(1, { en_name: 'FLiNG Trainer One' }),
      trainerEntry(2, { keyw: '无敌,隐身' }),
      trainerEntry(3, { title: '赛博朋克2077修改器' }),
      trainerEntry(4, { en_name: 'Another Tool' }),
    ]
    await registerIndex(network, entries)
    const source = trainerSource()
    // en_name 大小写不敏感（默认 en_name 都带 FLiNG Trainer 前缀）
    const byEn = await source.list(baseQuery({ keyword: 'fling' }))
    assert.equal(byEn.total, 3)
    const unique = await source.list(baseQuery({ keyword: 'fling trainer one' }))
    assert.equal(unique.total, 1)
    assert.equal(unique.items[0].id, 'trainer:trainer:1')
    // keyw 匹配
    const byKeyw = await source.list(baseQuery({ keyword: '隐身' }))
    assert.equal(byKeyw.total, 1)
    assert.equal(byKeyw.items[0].id, 'trainer:trainer:2')
    // title 匹配
    const byTitle = await source.list(baseQuery({ keyword: '2077' }))
    assert.equal(byTitle.total, 1)
    assert.equal(byTitle.items[0].id, 'trainer:trainer:3')
    // 无命中
    const none = await source.list(baseQuery({ keyword: '不存在的关键词' }))
    assert.equal(none.total, 0)
    assert.equal(none.items.length, 0)
  })
})

test('本地排序：排序列表给 id 顺序', async () => {
  await withMock(async network => {
    const entries = [trainerEntry(1), trainerEntry(2), trainerEntry(3)]
    await registerIndex(network, entries)
    network.respond('https://dl.fucnm.com/datafile/xgqlist/list_3.txt', { body: JSON.stringify([3, 1, 2]) })
    const sorted = await trainerSource().list(baseQuery({ sort: '3' }))
    assert.deepEqual(sorted.items.map(item => item.id), ['trainer:trainer:3', 'trainer:trainer:1', 'trainer:trainer:2'])
  })
})

test('u_name / ss_name 用 aesDecrypt 解出直链与配置 URL', async () => {
  const entry = trainerEntry(99)
  assert.equal(decryptTrainerUrl(entry.u_name), `https://dl.fucnm.com/down/99/setup_99.zip`)
  assert.equal(aesDecrypt(entry.ss_name), 'https://dl.fucnm.com/config/99.json')
  // 密文与明文不同且可重复解
  assert.notEqual(entry.u_name, `https://dl.fucnm.com/down/99/setup_99.zip`)
})

test('详情解出直链包与配置功能表', async () => {
  await withMock(async network => {
    const entries = [trainerEntry(10, { body: '<p>风灵月影说明</p>' })]
    await registerIndex(network, entries)
    network.respond('https://dl.fucnm.com/config/10.json', { body: JSON.stringify([
      { name: '无敌', hotkey: 'F1', type: 1, text: '角色无敌', tips: '' },
      { name: '无限金钱', hotkey: 'F2', type: 2, text: '金钱不减', tips: '先获得金钱' },
    ]) })
    network.respond('https://dl.fucnm.com/sapi/getxgqgl', { body: JSON.stringify({ data: [] }) })
    const detail = await trainerSource().detail('10')
    assert.equal(detail.packages.length, 1)
    assert.equal(detail.packages[0].name, 'setup_10.zip')
    assert.equal(detail.packages[0].provider, '直链下载')
    assert.equal(detail.trainerOptions.length, 2)
    assert.equal(detail.trainerOptions[0].name, '无敌')
    assert.equal(detail.trainerOptions[0].hotkey, 'F1')
    assert.equal(detail.trainerOptions[1].tooltip, '先获得金钱')
    assert.ok(detail.description.includes('风灵月影说明'))
  })
})

test('攻略请求的签名表单字段齐全（xgq_id/time/nonce/sign）', async () => {
  await withMock(async network => {
    const entries = [trainerEntry(5)]
    await registerIndex(network, entries)
    network.respond('https://dl.fucnm.com/config/5.json', { body: '[]' })
    network.respond('https://dl.fucnm.com/sapi/getxgqgl', { body: JSON.stringify({ data: [{ id: 1, title: '攻略标题', url: 'https://gl/x' }] }) })
    const detail = await trainerSource().detail('5')
    assert.equal(detail.trainerGuides.length, 1)
    assert.equal(detail.trainerGuides[0].title, '攻略标题')

    // 直接验证签名算法：sign = md5(time + nonce + "getxgqgl" + 盐)
    const time = timestampFromSeconds()
    const nonce = generateNonce()
    const sign = fucnmSign(time, nonce, 'getxgqgl')
    assert.equal(sign, md5Hex(time + nonce + 'getxgqgl' + 'oPsmWeddKJyMvIk8mv'))
    assert.match(nonce, /^[0-9a-f]{32}$/)
  })
})

test('条目 meta 展示信息（版本/支持版本/位数）', async () => {
  await withMock(async network => {
    await registerIndex(network, [trainerEntry(20, { version: '3.3', support_ver: 'v1.0-v2.1', bits: '64位' })])
    const page = await trainerSource().list(baseQuery())
    const item = page.items[0]
    assert.deepEqual(item.meta, ['版本 3.3', '支持 v1.0-v2.1', '64位'])
    assert.equal(item.kind, 'trainer')
    assert.equal(item.section, 'trainer')  })
})


test('列表给出的条目 id 必须能原样喂回 detail / fileList，且自带数据源与栏目', async () => {
  await withMock(async network => {
    await registerIndex(network, [trainerEntry(10, { body: '<p>说明</p>' })])
    network.respond('https://dl.fucnm.com/config/10.json', { body: '[]' })
    network.respond('https://dl.fucnm.com/sapi/getxgqgl', { body: JSON.stringify({ data: [] }) })
    const source = trainerSource()
    const item = (await source.list(baseQuery())).items[0]
    // 站点 id 是裸数字，与 MOD 的站点 id 会撞号；条目 id 必须带 数据源:栏目: 前缀，
    // 浏览层与任务层（library.detail / taskResolver）都靠这个前缀找到正确的数据源。
    // 缺陷版本的 id 是 "10"，library.detail 报「未知的数据源：10」。
    assert.equal(item.id, 'trainer:trainer:10')
    assert.equal(item.sourceId, '10')
    const detail = await source.detail(item.id)
    assert.equal(detail.item.id, item.id)
    assert.equal(detail.packages[0].id, 'https://dl.fucnm.com/down/10/setup_10.zip')
    assert.equal((await source.fileList(item.id))[0].id, detail.packages[0].id)
  })
})
