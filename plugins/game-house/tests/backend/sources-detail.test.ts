/**
 * detail() 与 fileList() 专项单测：
 * - ode 条目 id 的 section 解析（ode:pc / ode:console / ode:software / 旧裸数字兼容）；
 * - ode 详情 packages 映射（file / folder / warehousing）与文件夹进入的请求参数（path 有值/无值）；
 * - 封面令牌格式（cover 原始 URL + coverToken img:base64url）；
 * - trainer 详情 packages（解密直链作包 id）。
 * 不联网，全部用 createMockAdapter() + network.respond() 假响应。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockAdapter } from '../../backend/adapters/mock.ts'
import { getAdapter, setAdapter } from '../../backend/adapters/current.ts'
import { aesEncrypt } from '../../backend/crypto.ts'
import type { LibraryQuery } from '../../src/shared/contracts.ts'
import { odeSource, extractCodeFromPkg } from '../../backend/sources/ode.ts'
import { trainerSource, resetTrainerCache } from '../../backend/sources/trainer.ts'
import type { MockNetwork } from '../../backend/adapters/mock.ts'

const ODE_URL = 'https://www.uy5.net/wodown/resources/'

function baseQuery(patch: Partial<LibraryQuery> = {}): LibraryQuery {
  return { section: 'pc', source: 'ode', page: 1, keyword: '', category: '', sort: '', ...patch }
}

async function withMock(run: (network: MockNetwork) => Promise<void>): Promise<void> {
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

/* ---------------- id 的 section 解析 ---------------- */

const SECTION_BODIES: Record<string, string> = {
  pc: JSON.stringify({ list: [{ id: '1001', post_title: 'PC 游戏', Subtitle: '', thumbnail_img: 'https://cdn.uy5.net/pc.jpg', appIco: '', categories: '动作' }], Numberofarticlescount: 1, pageSize: 24 }),
  console: JSON.stringify({ list: [{ id: '2002', post_title: '主机游戏', Subtitle: '', thumbnail_img: '', appIco: 'https://cdn.uy5.net/icon.png', categories: '' }], Numberofarticlescount: 1, pageSize: 24 }),
  software: JSON.stringify({ list: [{ id: '3003', post_title: '某软件', Subtitle: '', thumbnail_img: 'https://cdn.uy5.net/sw.jpg', appIco: '', categories: '' }], Numberofarticlescount: 1, pageSize: 24 }),
}

test('list 按 section 生成带前缀的条目 id 与 kind', async () => {
  await withMock(async network => {
    network.respond(ODE_URL, { body: SECTION_BODIES.pc })
    const pc = await odeSource().list(baseQuery({ section: 'pc' }))
    assert.equal(pc.items[0].id, 'ode:pc:1001')
    assert.equal(pc.items[0].kind, 'game')
    assert.equal(pc.items[0].section, 'pc')

    network.respond(ODE_URL, { body: SECTION_BODIES.software })
    const sw = await odeSource().list(baseQuery({ section: 'software' }))
    assert.equal(sw.items[0].id, 'ode:software:3003')
    assert.equal(sw.items[0].kind, 'software')
    assert.equal(sw.items[0].section, 'software')

    network.respond(ODE_URL, { body: SECTION_BODIES.console })
    const console_ = await odeSource().list(baseQuery({ section: 'console' }))
    assert.equal(console_.items[0].id, 'ode:console:2002')
    assert.equal(console_.items[0].section, 'console')
    // thumbnail_img 为空时兜底 appIco
    assert.equal(console_.items[0].cover, 'https://cdn.uy5.net/icon.png')
  })
})

/* ---------------- detail 的 section 解析 ---------------- */

function detailBody(id: string, title: string): string {
  return JSON.stringify({
    id,
    post_title: title,
    Subtitle: '',
    thumbnail_img: `https://cdn.uy5.net/${id}.jpg`,
    GameIntroduction: '<p>介绍</p>',
    carousel: [],
    carouselVideoInfo: {},
    MinimumConfiguration: '',
    recommendConfiguration: '',
    datetime: '2024-06-01',
    filesize_z: '10 GB',
    offcialUrl: '',
    gfurl: '',
  })
}

const EMPTY_FILES = JSON.stringify({ list: [] })

test('detail 从 id 解析 section：pc / console / software 三种', async () => {
  await withMock(async network => {
    for (const [section, id] of [['pc', '111'], ['console', '222'], ['software', '333']] as const) {
      let call = 0
      network.respond(ODE_URL, () => {
        call++
        return { body: call === 1 ? detailBody(id, `${section}-标题`) : EMPTY_FILES }
      })
      const detail = await odeSource().detail(`ode:${section}:${id}`)
      assert.equal(detail.item.section, section, `section=${section}`)
      assert.equal(detail.item.kind, section === 'software' ? 'software' : 'game')
      assert.equal(detail.item.id, `ode:${section}:${id}`)
      assert.equal(detail.item.sourceId, id)
      assert.equal(detail.item.title, `${section}-标题`)
    }
  })
})

test('detail 兼容旧裸数字 id（按 pc 处理）', async () => {
  await withMock(async network => {
    let call = 0
    network.respond(ODE_URL, () => {
      call++
      return { body: call === 1 ? detailBody('444', '旧 id 条目') : EMPTY_FILES }
    })
    const detail = await odeSource().detail('444')
    assert.equal(detail.item.section, 'pc')
    assert.equal(detail.item.kind, 'game')
    assert.equal(detail.item.id, '444')
    assert.equal(detail.item.sourceId, '444')
  })
})

/* ---------------- 详情 packages 与封面令牌 ---------------- */

const DETAIL_WITH_FILES = detailBody('4992070', '带资源包的游戏')
const FILES_BODY = JSON.stringify({
  list: [
    { type: 'file', coID: 'https://cloud.189.cn/t/AbCdEf?pwd=1234', coName: 'Game.7z.001', coSize: '145.55 GB', openPath: 'Game/Game.exe', udTime: '2024-01-15' },
    { type: 'folder', coID: '449912045', coName: 'DLC 文件夹', coSize: '', childCount: 3 },
    { type: 'warehousing', coID: 'x1', coName: '打包中.zip', coSize: '' },
  ],
  type: 'game',
})

test('detail 的 packages 含 file/folder/warehousing 三种状态', async () => {
  await withMock(async network => {
    let call = 0
    network.respond(ODE_URL, () => {
      call++
      return { body: call === 1 ? DETAIL_WITH_FILES : FILES_BODY }
    })
    const detail = await odeSource().detail('ode:pc:4992070')
    assert.equal(detail.packages.length, 3)
    const [file, folder, warehousing] = detail.packages
    // 文件行：id 就是分享链接，天翼云盘
    assert.equal(file.state, 'ready')
    assert.equal(file.provider, '天翼云盘')
    assert.equal(file.id, 'https://cloud.189.cn/t/AbCdEf?pwd=1234')
    assert.equal(file.exePath, 'Game/Game.exe')
    assert.equal(extractCodeFromPkg(file), '1234')
    // 文件夹行：id 是文件夹 id，可在 fileList 里作 path
    assert.equal(folder.state, 'folder')
    assert.equal(folder.id, '449912045')
    assert.equal(folder.childCount, 3)
    // warehousing 不可下载
    assert.equal(warehousing.state, 'warehousing')
  })
})

test('封面令牌：cover 原始 URL，coverToken 是 img:<base64url>', async () => {
  await withMock(async network => {
    let call = 0
    network.respond(ODE_URL, () => {
      call++
      return { body: call === 1 ? DETAIL_WITH_FILES : EMPTY_FILES }
    })
    const detail = await odeSource().detail('ode:pc:4992070')
    assert.equal(detail.item.cover, 'https://cdn.uy5.net/4992070.jpg')
    assert.equal(
      detail.item.coverToken,
      `img:${Buffer.from('https://cdn.uy5.net/4992070.jpg', 'utf8').toString('base64url')}`,
    )
    // base64url 不含 + / =
    assert.ok(!/[+/=]/.test(detail.item.coverToken.slice(4)))
  })
})

/* ---------------- 文件夹进入的请求参数 ---------------- */

test('fileList 根目录与子目录的请求参数（对照原项目）', async () => {
  await withMock(async network => {
    network.respond(ODE_URL, { body: FILES_BODY })
    const packages = await odeSource().fileList('ode:pc:4992070')
    assert.equal(packages.length, 3)
    // 根目录：id=<条目id>&path=null&version=1
    const rootUrl = network.log[0].url
    assert.ok(rootUrl.includes(ODE_URL))
    assert.equal(network.log.length, 1)

    // 进入子目录：id=<空>&path=<文件夹id>&version=1
    network.respond(ODE_URL, { body: JSON.stringify({ list: [{ type: 'file', coID: 'https://cloud.189.cn/t/Sub1?pwd=9', coName: 'DLC1.7z', coSize: '1 GB' }] }) })
    const sub = await odeSource().fileList('ode:pc:4992070', packages[1].id)
    assert.equal(sub.length, 1)
    assert.equal(sub[0].id, 'https://cloud.189.cn/t/Sub1?pwd=9')
  })
})

test('fileList 兼容旧裸数字 id', async () => {
  await withMock(async network => {
    network.respond(ODE_URL, { body: FILES_BODY })
    const packages = await odeSource().fileList('4992070')
    assert.equal(packages.length, 3)
  })
})

test('odePost 非 2xx 的错误文案带站点名', async () => {
  await withMock(async network => {
    network.respond(ODE_URL, { status: 500, body: '' })
    network.respond('https://www.kelongwo.cn/wodown/resources/', { status: 503, body: '' })
    await assert.rejects(
      odeSource().detail('ode:software:333'),
      (error: { code?: string; message?: string }) => error.code === 'SOURCE_ERROR' && error.message.includes('软件站'),
    )
    await assert.rejects(
      odeSource().fileList('ode:console:222'),
      (error: { code?: string; message?: string }) => error.code === 'SOURCE_ERROR' && error.message.includes('主机游戏站'),
    )
  })
})

/* ---------------- trainer 详情 packages ---------------- */

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

function trainerEntry(id: number): TrainerEntry {
  return {
    id,
    title: `修改器${id}`,
    en_name: `Trainer${id}`,
    keyw: '',
    litpic: `https://dl.fucnm.com/img/${id}.jpg`,
    version: '1.0',
    support_ver: 'v1.0+',
    bits: '64位',
    u_name: aesEncrypt(`https://dl.fucnm.com/down/${id}/trainer_${id}.zip`),
    ss_name: aesEncrypt(`https://dl.fucnm.com/config/${id}.json`),
    down_total: 10,
    pubdate_at: '2024-05-01',
    body: '',
  }
}

test('trainer 详情 packages：解密直链作包 id，state ready', async () => {
  await withMock(async network => {
    const entry = trainerEntry(77)
    network.respond('https://dl.fucnm.com/datafile/xgqdetail/index.txt', { body: JSON.stringify({ total: 1, page: 1, pagesize: 50 }) })
    network.respond('https://dl.fucnm.com/datafile/xgqdetail/list_1.txt', { body: JSON.stringify([entry]) })
    network.respond('https://dl.fucnm.com/config/77.json', { body: '[]' })
    network.respond('https://dl.fucnm.com/sapi/getxgqgl', { body: JSON.stringify({ data: [] }) })

    const detail = await trainerSource().detail('77')
    assert.equal(detail.packages.length, 1)
    const pkg = detail.packages[0]
    assert.equal(pkg.state, 'ready')
    assert.equal(pkg.provider, '直链下载')
    // 包 id 是解密后的下载直链，任务模块可直接下载
    assert.equal(pkg.id, `https://dl.fucnm.com/down/77/trainer_77.zip`)
    assert.equal(pkg.name, `trainer_77.zip`)

    // fileList 返回同一个直链包
    const files = await trainerSource().fileList('77')
    assert.equal(files.length, 1)
    assert.equal(files[0].id, pkg.id)
  })
})
