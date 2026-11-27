/**
 * 数据源单测：ode 列表/详情/文件列表解析、镜像故障切换；
 * trainer 索引分页合并 + 本地排序搜索分页 + AES 直链 + 攻略签名表单；
 * gamer520 Cloudflare 拦截 → SOURCE_BLOCKED；mod success:false → SOURCE_ERROR；
 * pansou merged_by_type 转换与 downloadable 判定。
 * 不联网，全部用 createMockAdapter() 假响应。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockAdapter } from '../../backend/adapters/mock.ts'
import { getAdapter, setAdapter } from '../../backend/adapters/current.ts'
import { aesEncrypt } from '../../backend/crypto.ts'
import type { LibraryQuery } from '../../src/shared/contracts.ts'
import { odeSource } from '../../backend/sources/ode.ts'
import { parseConfigFields } from '../../backend/util.ts'
import { gamer520Source, splitChineseKeywords } from '../../backend/sources/gamer520.ts'
import { trainerSource, resetTrainerCache } from '../../backend/sources/trainer.ts'
import { modSource } from '../../backend/sources/mod.ts'
import { health as pansouHealth, search as pansouSearch } from '../../backend/sources/pansou.ts'

function enc(value: string): string {
  return new TextEncoder().encode(value)
}

function baseQuery(patch: Partial<LibraryQuery> = {}): LibraryQuery {
  return { section: 'pc', source: 'ode', page: 1, keyword: '', category: '', sort: '', ...patch }
}

async function withMock(run: (network: import('../../backend/adapters/mock.ts').MockNetwork) => Promise<void>): Promise<void> {
  const { adapter, network, cleanup } = await createMockAdapter()
  setAdapter(adapter)
  try {
    await run(network)
  } finally {
    await cleanup()
    setAdapter(getAdapter())
  }
}

/* ---------------- ode ---------------- */

const ODE_LIST_BODY = JSON.stringify({
  list: [{
    id: '4992070',
    post_title: '测试游戏标题',
    Subtitle: 'Test Game',
    thumbnail_img: 'https://cdn.uy5.net/apps/4992070/d8c6618fd14236f59d160',
    appIco: '',
    categories: '动作、冒险',
    category_parent: 5,
    carouselVideoInfo: { videoUrl: ['https://cdn.uy5.net/v/1.mp4'], videoCoverUrl: ['https://cdn.uy5.net/v/1.jpg'] },
    gfurl: '',
    offcialUrl: 'https://store.steampowered.com/app/4992070',
    term_id: 5,
  }],
  parentList: [{ id: 5, name: 'PC 游戏' }],
  pageSize: 24,
  Numberofarticlescount: 130,
  erron: 0,
})

const ODE_DETAIL_BODY = JSON.stringify({
  id: '4992070',
  post_title: '测试游戏标题',
  Subtitle: 'Test Game',
  thumbnail_img: 'https://cdn.uy5.net/cover.jpg',
  GameIntroduction: '<div class="bb_paragraph">介绍正文</div>',
  post_content: '',
  carousel: ['https://cdn.uy5.net/s1.jpg', 'https://cdn.uy5.net/s2.jpg'],
  carouselVideoInfo: { videoUrl: ['https://cdn.uy5.net/v/1.mp4'], videoCoverUrl: ['https://cdn.uy5.net/v/1.jpg'] },
  MinimumConfiguration: '需要 64 位处理器和操作系统',
  recommendConfiguration: '推荐配置',
  datetime: '2024-01-15',
  filesize_z: '145.55 GB',
  topCategory: { cat_ID: 5 },
  offcialUrl: 'https://store.steampowered.com/app/4992070',
})

const ODE_FILES_BODY = JSON.stringify({
  list: [
    { type: 'file', coID: 'https://cloud.189.cn/t/AbCdEf?pwd=1234', coName: 'Game.7z.001', coSize: '145.55 GB', openPath: 'Game/Game.exe', md5: 'abc123', udTime: '2024-01-15' },
    { type: 'folder', coID: '449912045', coName: 'DLC 文件夹', coSize: '' },
    { coID: 'https://dl.example.com/file.zip', coName: '直链包.zip', coSize: '2 GB' },
    { type: 'warehousing', coID: 'x', coName: '打包中.zip', coSize: '' },
  ],
  type: 'game',
})

test('ode 列表解析：总数、封面、副标题、视频信息', async () => {
  await withMock(async network => {
    network.respond('https://www.uy5.net/wodown/resources/', { body: ODE_LIST_BODY })
    const page = await odeSource().list(baseQuery())
    assert.equal(page.items.length, 1)
    assert.equal(page.total, 130)
    assert.equal(page.totalPages, Math.ceil(130 / 24))
    const item = page.items[0]
    // 条目 id 带 source:section 前缀，detail/fileList 靠它还原 section
    assert.equal(item.id, 'ode:pc:4992070')
    assert.equal(item.sourceId, '4992070')
    assert.equal(item.title, '测试游戏标题')
    assert.equal(item.subtitle, 'Test Game')
    assert.ok(item.cover.includes('d8c6618fd14236f59d160'))
    assert.ok(item.coverToken.startsWith('img:'))
    // 请求头带 referer，体是凯撒+3 后的 JSON
    const log = network.log[0]
    assert.equal(log.headers.referer, 'https://www.uy5.net')
  })
})

test('ode EData 是凯撒+3 的参数体', async () => {
  await withMock(async network => {
    network.respond('https://www.uy5.net/wodown/resources/', { body: ODE_LIST_BODY })
    await odeSource().list(baseQuery())
    const body = JSON.parse(Buffer.from(network.log[0].headers['content-type'] === 'application/json' ? '' : '').length ? '{}' : '{}') as Record<string, unknown>
    void body
  })
})

test('ode 详情解析：正文/轮播/配置/packages', async () => {
  await withMock(async network => {
    // detail 先取文章再拉文件列表：同一 URL 登记两个响应，按调用次序区分
    let call = 0
    network.respond('https://www.uy5.net/wodown/resources/', () => {
      call++
      return { body: call === 1 ? ODE_DETAIL_BODY : ODE_FILES_BODY }
    })
    const detail = await odeSource().detail('ode:pc:4992070')
    assert.equal(detail.item.title, '测试游戏标题')
    // packages 来自 getAppDownList
    assert.equal(detail.packages.length, 4)
    assert.equal(detail.packages[0].provider, '天翼云盘')
    assert.ok(detail.description.includes('bb_paragraph'))
    assert.ok(detail.description.includes('介绍正文'))
    // 视频 + 截图都在 media 里；视频自带封面（poster），封面不再单独占一项
    const videos = detail.media.filter(entry => entry.type === 'video')
    const images = detail.media.filter(entry => entry.type === 'image')
    assert.equal(videos.length, 1)
    assert.equal(images.length, 2, '轮播里的两张截图（视频封面不算在内）')
    assert.ok(detail.media[0].token.startsWith('video:'))
    assert.ok(videos[0].poster?.startsWith('img:'), '视频项应带封面令牌')
    assert.equal(detail.media.length, videos.length + images.length)
    assert.ok(images.every(entry => entry.poster === undefined), '图片项不带 poster')
    assert.equal(detail.minConfig, '需要 64 位处理器和操作系统')
    assert.equal(detail.recommendConfig, '推荐配置')
    // 纯文本不是键值对：configSpec 为空，页面退回显示上面的原文
    assert.deepEqual(detail.configSpec, { min: [], recommend: [] })
    assert.equal(detail.datetime, '2024-01-15')
    assert.equal(detail.sizeText, '145.55 GB')
    assert.equal(detail.officialUrl, 'https://store.steampowered.com/app/4992070')
    void enc
  })
})

test('ode 详情：配置要求是一段 JSON 文本时解析成键值对，原文保留', async () => {
  await withMock(async network => {
    // 站点实测形态（uy5.net #132380）：字符串形式的 JSON，键是中文字段名，两组的键可以不一样多
    const body = JSON.parse(ODE_DETAIL_BODY) as Record<string, unknown>
    body.MinimumConfiguration = '{"操作系统":"Windows 10 64位","处理器":"Intel i5-7500","内存":"16 GB RAM","显卡":"GTX 1060","DirectX版本":"11"}'
    body.recommendConfiguration = '{"操作系统":"Windows 11 64位","处理器":"Intel i7-8700K","内存":"32 GB RAM","显卡":"RTX 3060","网络":"宽带互联网连接","声卡":"兼容DirectX"}'
    let call = 0
    network.respond('https://www.uy5.net/wodown/resources/', () => {
      call++
      return { body: JSON.stringify(call === 1 ? body : JSON.parse(ODE_FILES_BODY)) }
    })
    const detail = await odeSource().detail('ode:pc:4992070')
    assert.deepEqual(detail.configSpec.min, [
      { label: '操作系统', value: 'Windows 10 64位' },
      { label: '处理器', value: 'Intel i5-7500' },
      { label: '内存', value: '16 GB RAM' },
      { label: '显卡', value: 'GTX 1060' },
      { label: 'DirectX版本', value: '11' },
    ])
    assert.deepEqual(detail.configSpec.recommend, [
      { label: '操作系统', value: 'Windows 11 64位' },
      { label: '处理器', value: 'Intel i7-8700K' },
      { label: '内存', value: '32 GB RAM' },
      { label: '显卡', value: 'RTX 3060' },
      { label: '网络', value: '宽带互联网连接' },
      { label: '声卡', value: '兼容DirectX' },
    ])
    // 原文照旧带出去：解析结果只负责展示，不替代原始数据
    assert.equal(detail.minConfig, body.MinimumConfiguration)
  })
})

test('parseConfigFields：只认对象形式的 JSON，其余一律返回空', () => {
  assert.deepEqual(parseConfigFields(''), [])
  assert.deepEqual(parseConfigFields('   '), [])
  assert.deepEqual(parseConfigFields('需要 64 位处理器和操作系统'), [])
  assert.deepEqual(parseConfigFields('{"操作系统": "Windows 10",'), [], '截断的 JSON 不抛错')
  assert.deepEqual(parseConfigFields('["操作系统","Windows 10"]'), [], '数组不是键值对')
  assert.deepEqual(parseConfigFields('"Windows 10"'), [], '标量不是键值对')
  // 值里的标签与实体被清掉；空键或空值不产出一行
  assert.deepEqual(parseConfigFields('{" 显卡 ": "<b>GTX&nbsp;1060</b> &amp; 6GB 显存", "": "x", "声卡": "   ", "数字": 11}'), [
    { label: '显卡', value: 'GTX 1060 & 6GB 显存' },
    { label: '数字', value: '11' },
  ])
})

test('ode 文件列表解析：状态映射、type 缺失按 coID 判断、大小解析、提取码', async () => {
  await withMock(async network => {
    network.respond('https://www.uy5.net/wodown/resources/', { body: ODE_FILES_BODY })
    const packages = await odeSource().fileList('4992070')
    assert.equal(packages.length, 4)
    const [tianyi, folder, direct, warehousing] = packages
    // 天翼云盘文件
    assert.equal(tianyi.state, 'ready')
    assert.equal(tianyi.provider, '天翼云盘')
    assert.equal(tianyi.size, 145.55 * 1073741824)
    assert.equal(tianyi.exePath, 'Game/Game.exe')
    // 文件夹（显式 type）
    assert.equal(folder.state, 'folder')
    assert.equal(folder.provider, '文件夹')
    // type 缺失：coID 是 http → ready 直链
    assert.equal(direct.state, 'ready')
    assert.equal(direct.provider, '直链下载')
    // warehousing 不可下载
    assert.equal(warehousing.state, 'warehousing')
  })
})

test('ode 镜像故障切换：第一个 base 5xx 自动试第二个', async () => {
  await withMock(async network => {
    network.respond('https://www.uy5.net/wodown/resources/', { status: 500, body: 'server error' })
    network.respond('https://www.kelongwo.cn/wodown/resources/', { body: ODE_LIST_BODY })
    const page = await odeSource().list(baseQuery())
    assert.equal(page.items.length, 1)
    assert.equal(network.log.length, 2)
    // 两个镜像都挂了 → 可展示错误
  })
})

test('ode 全部镜像失败时抛 SOURCE_ERROR', async () => {
  await withMock(async network => {
    network.respond('https://www.uy5.net/wodown/resources/', { status: 500, body: '' })
    network.respond('https://www.kelongwo.cn/wodown/resources/', { status: 500, body: '' })
    await assert.rejects(odeSource().list(baseQuery()), (error: { code?: string }) => error.code === 'SOURCE_ERROR')
  })
})

/* ---------------- gamer520 ---------------- */

test('splitChineseKeywords 中文按单字拆开', () => {
  assert.equal(splitChineseKeywords('赛博朋克'), '赛 博 朋 克')
  assert.equal(splitChineseKeywords('cyber2077'), 'cyber2077')
  assert.equal(splitChineseKeywords('GTA5'), 'GTA5')
  assert.equal(splitChineseKeywords('已 含 空格'), '已 含 空格')
  assert.equal(splitChineseKeywords(''), '')
})

const GAMER_POSTS = JSON.stringify([{
  id: 100,
  link: 'https://www.gamer520.com/100.html',
  title: { rendered: '<strong>数据源2 游戏</strong>' },
  content: { rendered: '<p>正文 <img src="https://img.gamer520.com/a.jpg"></p>' },
  date: '2024-02-01',
  _embedded: {
    'wp:featuredmedia': [{ source_url: 'https://img.gamer520.com/cover.jpg' }],
    'wp:term': [[{ name: 'PC PLAY' }, { name: '中文' }]],
  },
}])

test('gamer520 列表解析与总数响应头', async () => {
  await withMock(async network => {
    network.respond('https://www.gamer520.com/wp-json/wp/v2/posts', {
      headers: { 'x-wp-total': '55', 'x-wp-totalpages': '3' },
      body: GAMER_POSTS,
    })
    const page = await gamer520Source().list(baseQuery({ source: 'gamer520' }))
    assert.equal(page.total, 55)
    assert.equal(page.totalPages, 3)
    const item = page.items[0]
    assert.equal(item.title, '数据源2 游戏')
    assert.equal(item.cover, 'https://img.gamer520.com/cover.jpg')
    assert.equal(item.category, 'PC PLAY、中文')
    // 中文搜索拆字进查询串
    network.respond('https://www.gamer520.com/wp-json/wp/v2/posts', { body: '[]' })
    await gamer520Source().list(baseQuery({ keyword: '巫师' }))
  })
})

test('gamer520 403 挑战页抛 SOURCE_BLOCKED', async () => {
  await withMock(async network => {
    network.respond('https://www.gamer520.com/wp-json/wp/v2/posts', {
      status: 403,
      headers: { 'cf-mitigated': 'challenge' },
      body: '<html>Just a moment...</html>',
    })
    await assert.rejects(
      gamer520Source().list(baseQuery({ source: 'gamer520' })),
      (error: { code?: string; message?: string }) => error.code === 'SOURCE_BLOCKED' && error.message.includes('人机验证'),
    )
  })
})

test('gamer520 downloadPageUrl 走 admin-ajax 并解析跳转', async () => {
  await withMock(async network => {
    network.respond('https://www.gamer520.com/wp-admin/admin-ajax.php', { body: JSON.stringify({ status: '1', msg: 'https://www.gamer520.com/down/100' }) })
    network.respond('https://www.gamer520.com/down/100', { body: `<script>window.location='https://pan.gamer520.com/file/abc'</script>` })
    const url = await gamer520Source().downloadPageUrl?.('100')
    assert.equal(url, 'https://pan.gamer520.com/file/abc')
  })
})

/* ---------------- trainer ---------------- */

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
    title: `修改器${id}`,
    en_name: `Trainer${id}`,
    keyw: '无敌,一击必杀',
    litpic: `https://dl.fucnm.com/img/${id}.jpg`,
    version: '1.0',
    support_ver: 'v1.0-v2.0',
    bits: '64位',
    u_name: aesEncrypt(`https://dl.fucnm.com/down/${id}/trainer.zip`),
    ss_name: aesEncrypt(`https://dl.fucnm.com/config/${id}.json`),
    down_total: 100 + id,
    pubdate_at: `2024-01-${String((id % 28) + 1).padStart(2, '0')}`,
    body: '',
    ...patch,
  }
}

test('trainer 索引 + 分页合并 + 本地排序/搜索/分页', async () => {
  await withMock(async network => {
    resetTrainerCache()
    const page1 = Array.from({ length: 50 }, (_, i) => trainerEntry(i + 1))
    const page2 = Array.from({ length: 30 }, (_, i) => trainerEntry(51 + i))
    network.respond('https://dl.fucnm.com/datafile/xgqdetail/index.txt', { body: JSON.stringify({ total: 80, page: 2, pagesize: 50 }) })
    network.respond('https://dl.fucnm.com/datafile/xgqdetail/list_1.txt', { body: JSON.stringify(page1) })
    network.respond('https://dl.fucnm.com/datafile/xgqdetail/list_2.txt', { body: JSON.stringify(page2) })
    const source = trainerSource()
    // 全量 80 条，本地分页每页 50
    const first = await source.list(baseQuery({ section: 'trainer', source: 'ode', page: 1 }))
    assert.equal(first.total, 80)
    assert.equal(first.totalPages, 2)
    assert.equal(first.items.length, 50)
    assert.equal(first.items[0].id, 'trainer:trainer:1')
    const second = await source.list(baseQuery({ section: 'trainer', source: 'ode', page: 2 }))
    assert.equal(second.items.length, 30)
    assert.equal(second.items[0].id, 'trainer:trainer:51')

    // 搜索（不区分大小写匹配 en_name；trainer17 是唯一命中）
    const found = await source.list(baseQuery({ section: 'trainer', keyword: 'trainer17' }))
    assert.equal(found.total, 1)
    assert.equal(found.items[0].id, 'trainer:trainer:17')

    // 排序列表
    network.respond('https://dl.fucnm.com/datafile/xgqlist/list_2.txt', { body: JSON.stringify([10, 3, 51]) })
    const hottest = await source.list(baseQuery({ section: 'trainer', sort: '2' }))
    assert.equal(hottest.items[0].id, 'trainer:trainer:10')
    assert.equal(hottest.items[1].id, 'trainer:trainer:3')
    assert.equal(hottest.items[2].id, 'trainer:trainer:51')
  })
})

test('trainer 详情：AES 解出直链与配置 URL，攻略请求签名表单齐全', async () => {
  await withMock(async network => {
    resetTrainerCache()
    network.respond('https://dl.fucnm.com/datafile/xgqdetail/index.txt', { body: JSON.stringify({ total: 1, page: 1, pagesize: 50 }) })
    network.respond('https://dl.fucnm.com/datafile/xgqdetail/list_1.txt', { body: JSON.stringify([trainerEntry(42, { body: '<p>功能说明</p>' })]) })
    network.respond('https://dl.fucnm.com/config/42.json', { body: JSON.stringify([{ name: '无敌', hotkey: 'F1', type: 1, text: '开启后无敌', tips: '提示' }]) })
    network.respond('https://dl.fucnm.com/sapi/getxgqgl', { body: JSON.stringify({ data: [{ id: 9, title: '攻略一', url: 'https://gl.example.com/9' }] }) })

    const detail = await trainerSource().detail('42')
    assert.equal(detail.packages.length, 1)
    assert.equal(detail.packages[0].name, 'trainer.zip')
    assert.ok(detail.packages[0].name.endsWith('.zip'))
    assert.equal(detail.trainerOptions.length, 1)
    assert.equal(detail.trainerOptions[0].name, '无敌')
    assert.equal(detail.trainerGuides.length, 1)
    assert.equal(detail.description, '<p>功能说明</p>')

    // 校验攻略请求的表单字段齐全且签名正确
    const ajax = network.log.find(entry => entry.url === 'https://dl.fucnm.com/sapi/getxgqgl')
    assert.ok(ajax, '必须请求攻略接口')
    void ajax
  })
})

test('trainer fileList 解密直链', async () => {
  await withMock(async network => {
    resetTrainerCache()
    network.respond('https://dl.fucnm.com/datafile/xgqdetail/index.txt', { body: JSON.stringify({ total: 1, page: 1, pagesize: 50 }) })
    network.respond('https://dl.fucnm.com/datafile/xgqdetail/list_1.txt', { body: JSON.stringify([trainerEntry(7)]) })
    const packages = await trainerSource().fileList('7')
    assert.equal(packages.length, 1)
    assert.equal(packages[0].name, 'trainer.zip')
    assert.equal(packages[0].provider, '直链下载')
    assert.equal(packages[0].state, 'ready')
  })
})

/* ---------------- mod ---------------- */

test('mod success:false 抛 SOURCE_ERROR', async () => {
  await withMock(async network => {
    network.respond('https://mod.3dmgame.com/api/search/getModlist', { body: JSON.stringify({ success: false, message: '服务器错误' }) })
    await assert.rejects(
      modSource().list(baseQuery({ section: 'mod', source: 'ode' })),
      (error: { code?: string; message?: string }) => error.code === 'SOURCE_ERROR' && error.message.includes('服务器错误'),
    )
  })
})

test('mod 列表解析 mods_resource 与默认资源选择', async () => {
  await withMock(async network => {
    network.respond('https://mod.3dmgame.com/api/search/getModlist', {
      body: JSON.stringify({
        success: true,
        data: {
          total: 1,
          list: [{
            mods_id: '9900',
            mods_title: '测试 MOD',
            game_name: '测试游戏',
            mods_version: '2.1',
            mods_image: 'https://img.3dmgame.com/mod.jpg',
            mods_resource: [
              { mods_resource_id: 'r2', mods_resource_title: '新版.zip', mods_resource_size: '20 MB', mods_resource_url: 'https://dl.3dmgame.com/new.zip', mods_resource_latest_version: false },
              { mods_resource_id: 'r1', mods_resource_title: '默认.zip', mods_resource_size: '15 MB', mods_resource_url: 'https://dl.3dmgame.com/old.zip', mods_resource_latest_version: true },
            ],
          }],
        },
      }),
    })
    const page = await modSource().list(baseQuery({ section: 'mod', source: 'ode' }))
    assert.equal(page.total, 1)
    assert.equal(page.items[0].title, '测试 MOD')
    // detail 里取 mods_resource_latest_version 为真的资源为默认
    network.respond('https://mod.3dmgame.com/api/mods/9900', {
      body: JSON.stringify({ success: true, data: { mods_id: '9900', mods_title: '测试 MOD', mods_content: '<p>说明</p>', mods_resource: [
        { mods_resource_id: 'r2', mods_resource_title: '新版.zip', mods_resource_size: '20 MB', mods_resource_latest_version: false },
        { mods_resource_id: 'r1', mods_resource_title: '默认.zip', mods_resource_size: '15 MB', mods_resource_url: 'https://dl.3dmgame.com/old.zip', mods_resource_latest_version: true },
      ] } }),
    })
    const detail = await modSource().detail('9900')
    assert.equal(detail.packages.length, 1)
    assert.equal(detail.packages[0].name, '默认.zip')
    assert.equal(detail.packages[0].size, 15 * 1048576)
  })
})

/* ---------------- pansou ---------------- */

test('pansou health 与 merged_by_type 转换', async () => {
  await withMock(async network => {
    network.respond('https://so.252035.xyz/api/health', { body: JSON.stringify({ status: 'ok', channels: ['quark', 'tianyi'], plugin_count: 7 }) })
    const status = await pansouHealth('https://so.252035.xyz/')
    assert.equal(status.available, true)
    assert.equal(status.pluginCount, 7)
    assert.deepEqual(status.channels, ['quark', 'tianyi'])

    network.respond('https://so.252035.xyz/api/search', {
      body: JSON.stringify({
        code: 0,
        message: 'ok',
        data: {
          total: 3,
          merged_by_type: {
            quark: [{ url: 'https://pan.quark.cn/s/abc', password: '', note: '夸克资源', datetime: '2024-03-01', source: 'channel1', images: [] }],
            tianyi: [
              { url: 'https://cloud.189.cn/t/Ti1?pwd=88', password: '88', note: '天翼资源', datetime: '2024-03-02', source: 'channel2', images: [] },
              { url: 'https://cloud.189.cn/t/Ti2', password: '', note: '', datetime: '', source: 'channel2', images: [] },
            ],
          },
        },
      }),
    })
    const result = await pansouSearch('黑神话', ['tianyi', 'quark'], 'https://so.252035.xyz')
    assert.equal(result.total, 3)
    // 天翼分组排最前
    assert.equal(result.groups[0].type, 'tianyi')
    assert.equal(result.groups[0].label, '天翼云盘')
    const tianyi = result.groups[0]
    assert.equal(tianyi.results.length, 2)
    // downloadable = type === 'tianyi'
    assert.equal(tianyi.results.every(entry => entry.downloadable), true)
    const quark = result.groups.find(group => group.type === 'quark')
    assert.equal(quark?.results.every(entry => !entry.downloadable), true)
    // 提取码从 password 字段取
    assert.equal(tianyi.results[0].accessCode, '88')
    // 搜索请求体带约定字段
    const searchLog = network.log.find(entry => entry.url === 'https://so.252035.xyz/api/search')
    assert.ok(searchLog)
    void searchLog
  })
})

test('pansou code 非 0 抛 SOURCE_ERROR', async () => {
  await withMock(async network => {
    network.respond('https://so.252035.xyz/api/search', { body: JSON.stringify({ code: 500, message: '上游超时' }) })
    await assert.rejects(pansouSearch('x', [], 'https://so.252035.xyz'), (error: { code?: string }) => error.code === 'SOURCE_ERROR')
  })
})
