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

/**
 * 页面在登录窗口成功后存进保险库的凭据：只有 cookie，没有旧登录流程才会有的那些字段。
 * 现在的形态是逐条带 domain/path 的 `cookies`（加一份拍平的 `cookie` 兼容旧代码）。
 */
const WEB_CREDENTIAL = JSON.stringify({
  cookies: [
    { name: 'SESSION', value: 'abc', domain: 'cloud.189.cn', path: '/' },
    { name: 'cookiesdl', value: 'xyz', domain: '.cloud.189.cn', path: '/' },
  ],
  cookie: 'SESSION=abc; cookiesdl=xyz',
  savedAt: 1795400000,
})

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
  // account 一并带出：设置页的「已保存账号」与「清除已保存的账号」靠它才有依据。
  assert.deepEqual(state, { state: 'logged-in', nickname: '网页登录用户', account: '13800138000' })
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

test('连续校验登录：第二次请求仍带完整登录 cookie，不被 jar 里新增的少量 cookie 遮蔽', async () => {
  // 回归：checkLogin 曾写成 `jar.header() || credential.cookie`。第一次校验用完整凭据成功，
  // 但响应里的 Set-Cookie 进了 jar；第二次校验时 jar 非空却只有那几条新 cookie，
  // 把完整登录凭据整个遮蔽掉，表现为「刚登录、刷新一次状态就显示已过期」。
  const mock = await createMockAdapter()
  setAdapter(mock.adapter)
  let calls = 0
  mock.network.respond(BRIEF_INFO, () => {
    calls++
    return {
      body: JSON.stringify({ nickname: '网页登录用户', account: '13800138000' }),
      // 第一轮下发一条额外 cookie，让 jar 在第二次校验时非空
      setCookies: calls === 1 ? ['ROTATED=1; Path=/'] : [],
    }
  })
  const client = new Cloud189Client({ loadSession: async () => WEB_CREDENTIAL })
  assert.equal((await client.checkLogin()).state, 'logged-in')
  assert.equal((await client.checkLogin()).state, 'logged-in', '第二次校验不能因为 jar 里只有新 cookie 就判过期')
  const sent = mock.network.log.filter(entry => entry.url.startsWith(BRIEF_INFO))
  assert.equal(sent.length, 2)
  for (const entry of sent) {
    assert.match(entry.headers.cookie ?? '', /SESSION=abc/, '每次都带凭据里的会话 cookie')
    assert.match(entry.headers.cookie ?? '', /cookiesdl=xyz/)
  }
  assert.match(sent[1].headers.cookie ?? '', /ROTATED=1/, 'jar 里新拿到的 cookie 也要叠加进去')
})

test('校验登录不会把服务端下发的删除指令存成空 cookie 盖掉真会话', async () => {
  // 天翼在未登录时对 getUserBriefInfo 下发 `COOKIE_LOGIN_USER=; Max-Age=0`。
  // 旧实现把空值当普通 cookie 存进 jar，第二次请求就用空值盖掉凭据里的真会话，
  // 于是「刚登录成功，刷新一次状态就显示已过期」。
  const mock = await createMockAdapter()
  setAdapter(mock.adapter)
  let calls = 0
  mock.network.respond(BRIEF_INFO, () => {
    calls++
    return calls === 1
      ? { body: JSON.stringify({ nickname: '网页登录用户' }), setCookies: ['COOKIE_LOGIN_USER=; Max-Age=0; Domain=.cloud.189.cn; Path=/'] }
      : { body: JSON.stringify({ nickname: '网页登录用户' }) }
  })
  const client = new Cloud189Client({ loadSession: async () => WEB_CREDENTIAL })
  assert.equal((await client.checkLogin()).state, 'logged-in')
  assert.equal((await client.checkLogin()).state, 'logged-in')
  const sent = mock.network.log.filter(entry => entry.url.startsWith(BRIEF_INFO))
  assert.equal(sent[1].headers.cookie?.includes('COOKIE_LOGIN_USER='), false, '不能把删除指令变成空值 cookie')
  assert.match(sent[1].headers.cookie ?? '', /SESSION=abc/)
})

test('凭据里同名不同域的 cookie 各自带域：不会被压成一条而丢掉真会话', async () => {
  // 天翼在 cloud.189.cn 与 open.e.189.cn 会下发同名但值不同的 cookie，服务端靠 domain 区分。
  // 拍平成字符串按名字只留一条，等于把真正的会话 cookie 换成 SSO 流程的。
  const mock = await createMockAdapter()
  setAdapter(mock.adapter)
  mock.network.respond(BRIEF_INFO, { body: JSON.stringify({ nickname: '网页登录用户' }) })
  const credential = JSON.stringify({
    cookies: [
      { name: 'COOKIE_LOGIN_USER', value: 'REAL_SESSION', domain: '.cloud.189.cn', path: '/' },
      { name: 'COOKIE_LOGIN_USER', value: 'SSO_TEMP', domain: '.open.e.189.cn', path: '/' },
    ],
    cookie: 'COOKIE_LOGIN_USER=REAL_SESSION; COOKIE_LOGIN_USER=SSO_TEMP',
  })
  await new Cloud189Client({ loadSession: async () => credential }).checkLogin()
  const sent = mock.network.log.find(entry => entry.url.startsWith(BRIEF_INFO))
  assert.match(sent?.headers.cookie ?? '', /COOKIE_LOGIN_USER=REAL_SESSION/, '发往 cloud 的请求必须带 cloud 域下的那条')
  assert.equal(sent?.headers.cookie?.includes('SSO_TEMP') ?? true, false, 'open.e 域下的同名 cookie 不该发给 cloud')
})
