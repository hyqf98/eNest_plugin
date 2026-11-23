/**
 * 网页登录得到的会话：后端只收到页面存好的 secretRef（凭据是 { cookie, savedAt }，没有 sessionKey / refreshToken）。
 * 这里钉住两件事：
 *   1. AuthService.saveSession 保存后会校验会话——校验不过就标成过期，不把坏会话当成已登录；
 *   2. 真实的 Cloud189Client 能解析这种只有 cookie 的凭据，并只用它去验证登录。
 * 不联网：云盘客户端换成假的，网络层换成 mock。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Cloud189Client, type LoginState } from '../../backend/cloud189/index.ts'
import { AuthService, mockCloudClients } from '../../backend/library/authService.ts'
import { flushStore, loadAuthMeta, saveAuthMeta } from '../../backend/store.ts'
import { installHostStub, putSecret, type FakeHostPort } from './host-stub.ts'
import { createMockAdapter } from '../../backend/adapters/mock.ts'
import { setAdapter } from '../../backend/adapters/current.ts'

/** 页面在登录窗口成功后存进保险库的凭据：只有 cookie，没有旧登录流程才会有的那些字段 */
const WEB_CREDENTIAL = JSON.stringify({ cookie: 'SESSION=abc; cookiesdl=xyz', savedAt: 1795400000 })

async function resetAuth(stub: FakeHostPort): Promise<void> {
  saveAuthMeta({ sessionRef: '', accountRef: '', passwordRef: '', nickname: '', account: '', loginAt: 0 })
  await flushStore()
  stub.kv.delete('auth.meta')
  stub.secrets.clear()
}

async function withAuth(run: (context: { stub: FakeHostPort; service: AuthService }) => Promise<void>, checkResult: LoginState): Promise<void> {
  const stub = installHostStub()
  const restore = mockCloudClients(() => {
    const client = { async checkLogin() { return checkResult }, logout() {} }
    return client as unknown as Cloud189Client
  })
  await resetAuth(stub)
  try { await run({ stub, service: new AuthService() }) } finally { restore(); await resetAuth(stub) }
}

test('网页登录的会话校验通过：记为已登录，不保留任何账号密码引用', async () => {
  await withAuth(async ({ stub, service }) => {
    putSecret(stub, 'web1', WEB_CREDENTIAL)
    const result = await service.saveSession({ sessionRef: 'web1', rememberPassword: false })
    assert.deepEqual(result, { ok: true, removeRefs: [] })
    const info = await service.info()
    assert.equal(info.state, 'logged-in')
    assert.equal(info.nickname, '网页登录用户')
    const meta = await loadAuthMeta()
    assert.equal(meta.sessionRef, 'web1')
    assert.equal(meta.accountRef, '', '网页登录没有账号密码可记')
    assert.equal(meta.passwordRef, '')
  }, { state: 'logged-in', nickname: '网页登录用户' })
})

test('登录窗口关掉时到了成功页但会话其实无效：标成过期，不当成已登录', async () => {
  // 保护的是这种情况：用户没真正登录就跳到了成功地址，或天翼改了登录流程。
  // 不校验的话会存下一个坏会话，界面显示已登录，等到下载时才失败。
  await withAuth(async ({ stub, service }) => {
    putSecret(stub, 'web1', WEB_CREDENTIAL)
    const result = await service.saveSession({ sessionRef: 'web1', rememberPassword: false })
    assert.equal(result.ok, true, '保存动作本身成功（引用有效）')
    assert.equal((await service.info()).state, 'expired')
    // 下载前会被 requireClient 拦下，而不是带着坏会话去发请求
    await assert.rejects(service.requireClient(), (error: Error & { code?: string }) => error.code === 'LOGIN_REQUIRED')
  }, { state: 'expired', nickname: '' })
})

test('网页登录顶掉旧的账密登录：旧会话与不再记住的账号密码都交回页面删除', async () => {
  await withAuth(async ({ stub, service }) => {
    putSecret(stub, 'old', 'session-old'); putSecret(stub, 'web1', WEB_CREDENTIAL)
    await service.saveSession({ sessionRef: 'old', accountRef: 'a1', passwordRef: 'p1', account: '13800138000' })
    const result = await service.saveSession({ sessionRef: 'web1', rememberPassword: false })
    assert.deepEqual(result.removeRefs.sort(), ['a1', 'old', 'p1'])
    assert.equal((await loadAuthMeta()).sessionRef, 'web1')
  }, { state: 'logged-in', nickname: '网页登录用户' })
})

/* ---------------- 真实的 Cloud189Client：只有 cookie 的凭据 ---------------- */

const BRIEF_INFO = 'https://cloud.189.cn/api/portal/v2/getUserBriefInfo.action'

test('Cloud189Client 用只有 cookie 的凭据验证登录，且请求头就是凭据里的 cookie', async () => {
  const mock = await createMockAdapter()
  setAdapter(mock.adapter)
  mock.network.respond(BRIEF_INFO, { body: JSON.stringify({ nickname: '网页登录用户', account: '13800138000' }) })
  const client = new Cloud189Client({ loadSession: async () => WEB_CREDENTIAL })
  const state = await client.checkLogin()
  assert.deepEqual(state, { state: 'logged-in', nickname: '网页登录用户' })
  const sent = mock.network.log.find(entry => entry.url.startsWith(BRIEF_INFO))
  assert.ok(sent, '应发出一次登录校验请求')
  assert.equal(sent.headers.cookie, 'SESSION=abc; cookiesdl=xyz')
})

test('Cloud189Client 对没有 refreshToken 的凭据：校验不通过时直接判过期，不去尝试续期', async () => {
  const mock = await createMockAdapter()
  setAdapter(mock.adapter)
  // 服务端认为未登录：nickname 与 account 都为空
  mock.network.respond(BRIEF_INFO, { body: JSON.stringify({ nickname: '', account: '' }) })
  const client = new Cloud189Client({ loadSession: async () => WEB_CREDENTIAL })
  assert.deepEqual(await client.checkLogin(), { state: 'expired', nickname: '' })
  // 续期接口（getSessionForPC）不应被调用：没有 refreshToken 就没有可续的东西
  assert.equal(mock.network.log.filter(entry => entry.url.includes('getSessionForPC')).length, 0)
})

test('Cloud189Client 对空凭据或损坏凭据：判为未登录，不抛错', async () => {
  const mock = await createMockAdapter()
  setAdapter(mock.adapter)
  assert.deepEqual(await new Cloud189Client({ loadSession: async () => null }).checkLogin(), { state: 'logged-out', nickname: '' })
  assert.deepEqual(await new Cloud189Client({ loadSession: async () => 'not json' }).checkLogin(), { state: 'logged-out', nickname: '' })
  assert.equal(mock.network.log.length, 0, '没有 cookie 就不发请求')
})
