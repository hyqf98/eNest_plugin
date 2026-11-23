/**
 * 建任务时的资源解析：把条目 + 资源包 id 翻译成待下载文件。
 * 天翼云的接口全部用假响应；重点覆盖"分享链接#文件id"（详情页里点开分享文件夹后只选其中一个文件）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockAdapter } from '../../backend/adapters/mock.ts'
import { setAdapter } from '../../backend/adapters/current.ts'
import { installHostStub, putSecret } from './host-stub.ts'
import { flushStore, saveAuthMeta, saveItems, saveTasks } from '../../backend/store.ts'
import { AuthService } from '../../backend/library/authService.ts'
import { resolveRequest } from '../../backend/library/taskResolver.ts'
import { BackendError } from '../../backend/adapters/types.ts'

const SHARE = 'https://cloud.189.cn/t/AbCd1234?pwd=wxyz'
const SHARE_ID = '90001'
const FILES = [
  { id: '70011', name: 'Game.part01.rar', size: 3 * 1024 ** 3 },
  { id: '70012', name: 'Game.part02.rar', size: 3 * 1024 ** 3 },
  { id: '70013', name: 'Game.part03.rar', size: 1 * 1024 ** 3 },
]
const DIRECT = 'https://cdn.cloud.189.cn/download/direct'

/** 装好假的天翼云：已登录会话 + 分享解析 + 直链解析，返回下载直链被请求的次数 */
async function withCloud(run: (h: { auth: AuthService; directCalls: string[]; fileCalls: string[] }) => Promise<void>): Promise<void> {
  const stub = installHostStub()
  const mock = await createMockAdapter()
  setAdapter(mock.adapter)
  saveItems([]); saveTasks([])
  await flushStore()
  putSecret(stub, 'ref-session', JSON.stringify({ cookie: 'SESSION=cookie-session; LT=lt1', refreshToken: '' }))
  saveAuthMeta({ sessionRef: 'ref-session', accountRef: '', passwordRef: '', nickname: '测试', account: '', loginAt: 1 })
  await flushStore()

  const directCalls: string[] = []
  const fileCalls: string[] = []
  const json = (status: number, body: unknown) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  // 登录校验
  mock.network.respond('https://cloud.189.cn/api/portal/v2/getUserBriefInfo.action', json(200, { nickname: '测试用户', account: 'acct' }))
  // 分享：提取码校验 → 分享 id
  mock.network.respond('https://cloud.189.cn/api/open/share/checkAccessCode.action', json(200, { res_code: 0, shareId: SHARE_ID }))
  // 分享信息：是个文件夹
  mock.network.respond('https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action', json(200, { isFolder: true, fileName: '游戏分享', fileId: SHARE_ID }))
  // 列目录：第 1 页给全部文件，第 2 页给空（表示取完）
  mock.network.respond('https://cloud.189.cn/api/open/share/listShareDir.action', (req) => {
    const page = /pageNum=(\d+)/.exec(req.url)?.[1] ?? '1'
    return json(200, { fileListAO: page === '1' ? { fileList: FILES.map(file => ({ ...file, md5: '', mediaType: 0 })), folderList: [], count: String(FILES.length) } : { fileList: [], folderList: [], count: 0 } })
  })
  // sso 换 accessToken：302 到带 accessToken 的地址（落地页给个空响应即可，令牌从跳转地址里取）
  mock.network.respond('https://api.cloud.189.cn/open/oauth2/ssoH5.action', { status: 302, headers: {}, setCookies: [], location: 'https://cloud.189.cn/web/redirect.do?accessToken=TOKEN1' })
  mock.network.respond('https://cloud.189.cn/web/redirect.do', { status: 200, headers: {}, setCookies: [], body: '' })
  // 直链解析：记录请求的是哪个文件
  mock.network.respond('https://api.cloud.189.cn/open/file/getFileDownloadUrl.action', (req) => {
    const fileId = /fileId=(\d+)/.exec(req.url)?.[1] ?? ''
    fileCalls.push(fileId)
    return json(200, { res_code: 0, fileDownloadUrl: `${DIRECT}/${fileId}`, fileName: FILES.find(file => file.id === fileId)?.name ?? '', fileSize: FILES.find(file => file.id === fileId)?.size ?? 0 })
  })
  const auth = new AuthService()
  try {
    await run({ auth, directCalls, fileCalls })
  } finally {
    await mock.cleanup()
    saveItems([]); saveTasks([])
    saveAuthMeta({ sessionRef: '', accountRef: '', passwordRef: '', nickname: '', account: '', loginAt: 0 })
    await flushStore()
  }
}

const ITEM = 'ode:pc:5001'

test('选中整个分享链接：下载分享里的全部文件', async () => {
  await withCloud(async h => {
    const result = await resolveRequest({ auth: h.auth }, { itemId: ITEM, packageIds: [SHARE] })
    assert.equal(result.files.length, 3)
    assert.deepEqual(result.files.map(file => file.name).sort(), ['Game.part01.rar', 'Game.part02.rar', 'Game.part03.rar'])
    assert.equal(result.shareId, SHARE_ID)
    assert.equal(result.shareUrl, SHARE)
    assert.equal(result.accessCode, 'wxyz', '提取码从链接的 pwd= 里取')
    assert.deepEqual(h.fileCalls.sort(), ['70011', '70012', '70013'])
  })
})

test('分享链接#文件id：只下载这一个文件（详情页里点开分享文件夹后单选）', async () => {
  await withCloud(async h => {
    const result = await resolveRequest({ auth: h.auth }, { itemId: ITEM, packageIds: [`${SHARE}#70012`] })
    assert.equal(result.files.length, 1, '只应有一个文件')
    assert.equal(result.files[0].name, 'Game.part02.rar')
    assert.equal(result.files[0].key, '70012')
    assert.equal(result.files[0].url, `${DIRECT}/70012`)
    assert.ok(result.files[0].headers?.cookie, '天翼云直链必须带 cookie')
    assert.deepEqual(h.fileCalls, ['70012'], '只为选中的文件换直链')
    assert.equal(result.shareUrl, SHARE, '续传刷新直链时用的是不带 # 的分享链接')
  })
})

test('一次选中分享里的两个文件', async () => {
  await withCloud(async h => {
    const result = await resolveRequest({ auth: h.auth }, { itemId: ITEM, packageIds: [`${SHARE}#70011`, `${SHARE}#70013`] })
    assert.deepEqual(result.files.map(file => file.key).sort(), ['70011', '70013'])
    assert.deepEqual(h.fileCalls.sort(), ['70011', '70013'])
  })
})

test('粘贴链接场景：shareFileIds 指定要哪些文件', async () => {
  await withCloud(async h => {
    const result = await resolveRequest({ auth: h.auth }, { itemId: '', packageIds: [], share: { url: SHARE, accessCode: 'wxyz', title: '游戏分享' }, shareFileIds: ['70013'] })
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].key, '70013')
  })
})

test('选中的文件不在分享里：给出明确错误而不是静默跳过', async () => {
  await withCloud(async h => {
    await assert.rejects(
      resolveRequest({ auth: h.auth }, { itemId: ITEM, packageIds: [`${SHARE}#99999`] }),
      (error: BackendError) => error.code === 'SHARE_EMPTY',
    )
  })
})

test('普通直链资源不需要登录', async () => {
  const stub = installHostStub()
  const mock = await createMockAdapter()
  setAdapter(mock.adapter)
  saveItems([]); saveTasks([])
  saveAuthMeta({ sessionRef: '', accountRef: '', passwordRef: '', nickname: '', account: '', loginAt: 0 })
  await flushStore()
  try {
    const direct = 'https://dl.fucnm.com/files/trainer.zip'
    const result = await resolveRequest({ auth: new AuthService() }, { itemId: 'trainer:trainer:88', packageIds: [direct] })
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].url, direct)
    assert.equal(result.files[0].name, 'trainer.zip', '文件名取自直链')
    assert.equal(result.files[0].headers, undefined, '普通直链不带天翼云 cookie')
  } finally {
    await mock.cleanup()
    void stub
  }
})
