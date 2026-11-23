/**
 * 天翼云登录的离线单测：登录页取出的 lt / reqId 只在能放进 HTTP 头时才作为头发送。
 * 背景是实际报过的错：页面内容不是登录页时正则会截到含中文或换行的片段，原样放进请求头后
 * undici 在发请求前就拒绝整个请求（UND_ERR_INVALID_ARG），用户只看到一个裸错误码。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { createMockAdapter } from '../../backend/adapters/mock.ts'
import { setAdapter } from '../../backend/adapters/current.ts'
import { loginWithPassword } from '../../backend/cloud189/login.ts'

const OPEN = 'https://open.e.189.cn'
const ENTRY = 'https://cloud.189.cn/unifyLoginForPC.action'

/** 登录页上的公钥：现生成一把格式真实的（单行 base64），公钥解析失败会挡在被测行为前面 */
const PUBLIC_KEY = generateKeyPairSync('rsa', { modulusLength: 1024, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  .publicKey.replace(/\n/g, '').replace('-----BEGIN PUBLIC KEY-----', '').replace('-----END PUBLIC KEY-----', '')

/** 登录落地页：lt 用某个占位串替换 */
function loginPage(lt: string): string {
  return `<html><script>var lt = "${lt}"; var reqId = "req-7f3a"; var paramId = "p1"; var captchaToken = "c1";</script>
<input name="j_rsaKey" value="-----BEGIN PUBLIC KEY-----${PUBLIC_KEY}-----END PUBLIC KEY-----"></html>`
}

/** 可见的 ASCII 令牌（真实登录页的形状） */
const CLEAN_LT = 'e6f6ac81-6d7c-4c1d-9c14-d0b84c2f9f31'

async function boot(lt: string): Promise<ReturnType<typeof createMockAdapter>> {
  const mock = await createMockAdapter()
  setAdapter(mock.adapter)
  mock.network.respond(ENTRY, { body: loginPage(lt) })
  mock.network.respond(`${OPEN}/api/logbox/oauth2/appConf.do`, { body: '{"result":0}' })
  mock.network.respond(`${OPEN}/api/logbox/oauth2/needcaptcha.do`, { body: '0' })
  mock.network.respond(`${OPEN}/api/logbox/oauth2/loginSubmit.do`, { body: '{"result":-1,"msg":"账号或密码错误"}' })
  return mock
}

const sentTo = (mock: ReturnType<typeof createMockAdapter>, suffix: string) => mock.network.log.filter(entry => entry.url.includes(suffix))

test('正常的 lt / reqId 原样作为头发给 logbox 接口', async () => {
  const mock = await boot(CLEAN_LT)
  await loginWithPassword({ account: 'a', password: 'b', captcha: '', remember: false }).catch(() => undefined)
  const appConf = sentTo(mock, 'appConf.do')[0]
  assert.equal(appConf.headers.lt, CLEAN_LT)
  assert.equal(appConf.headers.reqid, 'req-7f3a')
})

test('含中文的 lt 不进请求头，请求仍然发出并拿到服务端的结果', async () => {
  const mock = await boot('登录已失效，请重新登录')
  const outcome = await loginWithPassword({ account: 'a', password: 'b', captcha: '', remember: false }).catch((error: unknown) => error)
  // 整条链路走完，停在服务端给的"账号或密码错误"上，而不是 undici 的参数错误
  assert.ok(outcome instanceof Error && /账号或密码错误/.test(outcome.message), `unexpected: ${String(outcome)}`)
  for (const entry of sentTo(mock, 'logbox')) {
    assert.equal(entry.headers.lt, undefined, `lt 泄漏到请求头：${entry.url}`)
    // reqId 一直是干净的，照常发送
    assert.equal(entry.headers.reqid, 'req-7f3a', entry.url)
  }
})

test('扫码登录的各步同样只带可放进请求头的 lt', async () => {
  const mock = await boot('含 空格\t和制表')
  mock.network.respond(`${OPEN}/api/logbox/oauth2/getUUID.do`, { body: '{"result":0,"uuid":"u1","encryuuid":"e1"}' })
  const { createQrSession } = await import('../../backend/cloud189/login.ts')
  const session = createQrSession()
  const outcome = await session.start().catch((error: unknown) => error)
  assert.ok(outcome instanceof Error, '非法 lt 下不应登录成功')
  for (const entry of sentTo(mock, 'logbox')) {
    assert.equal(entry.headers.lt, undefined, `lt 泄漏到请求头：${entry.url}`)
  }
})
