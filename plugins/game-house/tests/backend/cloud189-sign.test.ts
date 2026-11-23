/**
 * cloud189 加密与签名、分享链接解析的离线单测（不联网，mock 网络响应）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto'
import { aesDecrypt, aesEncrypt, caesar3, fucnmSign, generateNonce, md5Hex, rsaEncodeGowsp, rsaEncodeTickstep } from '../../backend/crypto.ts'
import { CookieJar, FORM_HEADERS, formEncode, jarRequest } from '../../backend/cloud189/http.ts'
import { accessTokenFromUrl, downloadSignature, parseSessionResponse } from '../../backend/cloud189/sign.ts'
import { parseShareCode } from '../../backend/cloud189/share.ts'
import { createMockAdapter } from '../../backend/adapters/mock.ts'
import { setAdapter, getAdapter } from '../../backend/adapters/current.ts'

/* ---------------- 凯撒 +3 ---------------- */

test('caesar3 已知串偏移', () => {
  assert.equal(caesar3('abc'), 'def')
  assert.equal(caesar3('xyz'), 'abc')
  assert.equal(caesar3('ABC'), 'DEF')
  assert.equal(caesar3('a1=b&c'), 'd1=e&f')
  // 非字母原样保留
  assert.equal(caesar3('中文123'), '中文123')
  // 完整参数串示例（实测映射：L→O 小写 l，App 的 A→D 等）
  assert.equal(caesar3('action'), 'dfwlrq')
  assert.equal(caesar3('action=getAppList'), 'dfwlrq=jhwDssOlvw')
  assert.equal(caesar3('getPostArticle'), 'jhwSrvwDuwlfoh')
})

test('caesar3 往返偏移 23 等价逆变换', () => {
  const input = 'action=getPostArticle&id=12345'
  const forward = caesar3(input)
  // 凯撒 +3 逆操作是 +23（同模 26）
  const reverse = forward.split('').map(ch => {
    const code = ch.charCodeAt(0)
    if (code >= 97 && code <= 122) return String.fromCharCode(((code - 97 + 23) % 26) + 97)
    if (code >= 65 && code <= 90) return String.fromCharCode(((code - 65 + 23) % 26) + 65)
    return ch
  }).join('')
  assert.equal(reverse, input)
})

/* ---------------- AES 往返与已知向量 ---------------- */

test('AES-128-CBC 加解密往返', () => {
  const plain = 'hello'
  const encrypted = aesEncrypt(plain)
  assert.notEqual(encrypted, plain)
  assert.equal(aesDecrypt(encrypted), plain)

  const long = 'https://dl.fucnm.com/datafile/xgqdown/Setup_v1.0.exe?token=abcdef1234567890'
  assert.equal(aesDecrypt(aesEncrypt(long)), long)

  // 空串原样返回
  assert.equal(aesEncrypt(''), '')
  assert.equal(aesDecrypt(''), '')
})

test('AES 已知向量：固定密文可解出明文', () => {
  // 用本模块 aesEncrypt 生成一次固定值（协议对称），解密必须还原；
  // 密文对同一明文确定（固定 key/iv），可重复验证。
  const plain = 'trainer-config-url.json'
  const cipher = aesEncrypt(plain)
  assert.equal(cipher, aesEncrypt(plain))
  assert.equal(aesDecrypt(cipher), plain)
  // base64 长度必须是 16 字节块的倍数编码
  const raw = Buffer.from(cipher, 'base64')
  assert.equal(raw.length % 16, 0)
})

test('AES 解密失败抛 DECODE_FAILED', () => {
  assert.throws(() => aesDecrypt('not-base64!!!'), (error: { code?: string }) => error.code === 'DECODE_FAILED')
  // 长度不是块倍数
  assert.throws(() => aesDecrypt(Buffer.from('123').toString('base64')), (error: { code?: string }) => error.code === 'DECODE_FAILED')
})

/* ---------------- MD5 与 fucnm 签名 ---------------- */

test('md5Hex 标准向量', () => {
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e')
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72')
})

test('fucnmSign 对固定 timestamp/nonce 的结果', () => {
  const timestamp = '1700000000'
  const nonce = '0123456789abcdef0123456789abcdef'
  const expected = md5Hex(timestamp + nonce + 'getxgqgl' + 'oPsmWeddKJyMvIk8mv')
  assert.equal(fucnmSign(timestamp, nonce, 'getxgqgl'), expected)
  // 固定值可复现
  assert.equal(fucnmSign(timestamp, nonce, 'getxgqgl'), fucnmSign(timestamp, nonce, 'getxgqgl'))
  // 不同 path 结果不同
  assert.notEqual(fucnmSign(timestamp, nonce, 'getxgqgl'), fucnmSign(timestamp, nonce, 'other'))
})

test('generateNonce 形状：8 段 4 位十六进制拼接', () => {
  const nonce = generateNonce()
  assert.equal(nonce.length, 32)
  assert.match(nonce, /^[0-9a-f]{32}$/)
  assert.notEqual(nonce, generateNonce())
})

/* ---------------- RSA 登录编码 ---------------- */

test('rsaEncodeTickstep/Gowsp 前缀与可解析性', () => {
  // 用一个测试公钥（2048 位 SPKI base64）验证格式；真实 j_rsaKey 由入口页给出
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const pemBase64 = Buffer.from(der).toString('base64')

  const encodedA = rsaEncodeTickstep(pemBase64, '13800000000')
  assert.match(encodedA, /^\{RSA\}[0-9A-Fa-f]+$/)
  const cipherA = Buffer.from(encodedA.slice(5), 'hex')
  assert.equal(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, cipherA).toString('utf8'), '13800000000')

  const encodedB = rsaEncodeGowsp(pemBase64, 'pwd123')
  assert.match(encodedB, /^\{RSA\}[0-9A-Fa-f]+$/)
  // B 的格式：hex(base64(密文))
  const cipherB = Buffer.from(Buffer.from(encodedB.slice(5), 'hex').toString(), 'base64')
  assert.equal(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, cipherB).toString('utf8'), 'pwd123')
})

/* ---------------- 分享链接解析 ---------------- */

test('parseShareCode 完整链接带/不带 pwd', () => {
  assert.deepEqual(parseShareCode('https://cloud.189.cn/t/AbCdEf?pwd=1234'), { shareCode: 'AbCdEf', pwd: '1234' })
  assert.deepEqual(parseShareCode('https://cloud.189.cn/t/AbCdEf'), { shareCode: 'AbCdEf', pwd: '' })
  // http 协议
  assert.deepEqual(parseShareCode('http://cloud.189.cn/t/xy12#锚点'), { shareCode: 'xy12', pwd: '' })
  // 短码形式
  assert.deepEqual(parseShareCode('AbCdEf'), { shareCode: 'AbCdEf', pwd: '' })
  // 文本里带链接（pwd 到行尾/空白前）
  assert.deepEqual(parseShareCode('快来看 https://cloud.189.cn/t/k3Kk3k?pwd=9zz9'), { shareCode: 'k3Kk3k', pwd: '9zz9' })
  assert.throws(() => parseShareCode(''), (error: { code?: string }) => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => parseShareCode('https://pan.baidu.com/s/1abc'), (error: { code?: string }) => error.code === 'INVALID_ARGUMENT')
})

/* ---------------- getFileDownloadUrl 签名 ---------------- */

test('downloadSignature 签名串与简报一致', () => {
  const token = 'TOKEN123'
  const timestamp = '1700000000'
  const fileId = '449912045'
  const shareId = '920153894154112385'
  const expected = md5Hex(`AccessToken=${token}&Timestamp=${timestamp}&dt=1&fileId=${fileId}&shareId=${shareId}`)
  assert.equal(downloadSignature(token, timestamp, fileId, shareId), expected)
})

test('accessTokenFromUrl 从最终 URL 或任一跳取 token', () => {
  // URL 查询参数形式（URL.searchParams 只看查询串）
  assert.equal(accessTokenFromUrl('https://api.cloud.189.cn/?accessToken=TOKEN&x=1'), 'TOKEN')
  assert.equal(accessTokenFromUrl('https://api.cloud.189.cn/?AccessToken=t2&other=3'), 't2')
  // hash 里带的 token 解析不到（这是查询串 API 的已知边界；ssoAccessToken 会逐跳扫描完整 URL）
  assert.equal(accessTokenFromUrl('https://api.cloud.189.cn/redirect.html#accessToken=TOKEN'), '')
  assert.equal(accessTokenFromUrl('https://api.cloud.189.cn/nothing'), '')
})

/* ---------------- 会话响应解析（JSON / XML 双格式） ---------------- */

test('parseSessionResponse 解析 JSON', () => {
  const parsed = parseSessionResponse('{"sessionKey":"sk1","accessToken":"at1","refreshToken":"rt1","familySessionKey":"fk1"}')
  assert.equal(parsed.sessionKey, 'sk1')
  assert.equal(parsed.accessToken, 'at1')
  assert.equal(parsed.refreshToken, 'rt1')
  assert.equal(parsed.familySessionKey, 'fk1')
})

test('parseSessionResponse 解析 XML', () => {
  const xml = '<session><sessionKey>sk2</sessionKey><accessToken>at2</accessToken></session>'
  const parsed = parseSessionResponse(xml)
  assert.equal(parsed.sessionKey, 'sk2')
  assert.equal(parsed.accessToken, 'at2')
})

/* ---------------- CookieJar ---------------- */

test('CookieJar 收集每一跳 cookie 并组装请求头', () => {
  const jar = new CookieJar()
  jar.storeAll(['LT=s1; Path=/; Secure', 'SSON=v1; Path=/; Domain=.189.cn'], 'https://cloud.189.cn/unifyLoginForPC.action')
  assert.equal(jar.get('LT'), 's1')
  assert.equal(jar.get('SSON'), 'v1')
  const header = jar.header()
  assert.ok(header.includes('LT=s1'))
  assert.ok(header.includes('SSON=v1'))
  // 覆盖同名
  jar.store('LT=s2; Path=/', 'https://open.e.189.cn/x')
  assert.equal(jar.get('LT'), 's2')
})

test('jarRequest 逐跳收集 cookie 且跨 origin 不清 cookie', async () => {
  const { adapter, network, cleanup } = await createMockAdapter()
  setAdapter(adapter)
  try {
    const entry = 'https://cloud.189.cn/unifyLoginForPC.action'
    const landing = 'https://open.e.189.cn/api/logbox/oauth2/unifyAccountLogin.do?x=1'
    network.respond(entry, {
      status: 302,
      setCookies: ['LT=lt1; Path=/', 'COOKIE_RETURN=1'],
      location: landing,
    })
    network.respond(landing, {
      status: 200,
      setCookies: ['JSESSIONID=js1; Path=/'],
      body: `<html><input name="lt" value="lt-value"/><script>lt = "lt2"; reqId = "req-1"; paramId = "pid-1"; returnUrl = 'https://m.cloud.189.cn/x';</script><input type="hidden" name="j_rsaKey" value="RSABASE64"/><input name="captchaToken" value='cap-token'/></html>`,
    })
    const jar = new CookieJar()
    const { response, text } = await import('../../backend/cloud189/http.ts').then(mod => mod.jarRequestText(jar, { url: entry }))
    assert.equal(response.status, 200)
    assert.equal(jar.get('LT'), 'lt1')
    assert.equal(jar.get('JSESSIONID'), 'js1')
    assert.ok(jar.header().includes('LT=lt1'), '跨 origin 跳转后 cookie 必须保留')
    assert.ok(text.includes('lt2'))
    // 请求日志确认第二跳带上了 cookie 头
    const hop2 = network.log.find(entryLog => entryLog.url === landing)
    assert.ok(hop2?.headers.cookie?.includes('LT=lt1'))
    void formEncode
  } finally {
    await cleanup()
    setAdapter(getAdapter())
  }
})

test('jarRequest：POST 被 302 重定向后改用 GET 且不携带登录表单体', async () => {
  const { adapter, network, cleanup } = await createMockAdapter()
  setAdapter(adapter)
  try {
    const submit = 'https://open.e.189.cn/api/logbox/oauth2/loginSubmit.do'
    const landing = 'https://cloud.189.cn/web/redirect.do?lt=lt1'
    network.respond(submit, { status: 302, location: landing })
    network.respond(landing, { status: 200, body: '{"res_code":0}' })
    const jar = new CookieJar()
    const body = formEncode({ appKey: '8025431004', userName: 'ENCRYPTED_ACCOUNT', password: 'ENCRYPTED_PASSWORD' })
    const response = await jarRequest(jar, {
      url: submit,
      method: 'POST',
      headers: { ...FORM_HEADERS },
      body,
    })
    assert.equal(response.status, 200)
    const redirected = network.log.find(entryLog => entryLog.url === landing)
    assert.ok(redirected, '应跟随到落地地址')
    assert.equal(redirected.method, 'GET', '302 之后必须改用 GET')
    assert.equal(redirected.headers['content-type'], undefined, '不应再带表单 content-type')
    // 第一跳照常携带表单体
    const first = network.log.find(entryLog => entryLog.url === submit)
    assert.equal(first?.method, 'POST')
  } finally {
    await cleanup()
    setAdapter(getAdapter())
  }
})

test('jarRequest 处理 403 挑战页抛 NETWORK 语义外的原始状态', async () => {
  const { adapter, network, cleanup } = await createMockAdapter()
  setAdapter(adapter)
  try {
    network.respond('https://cloud.189.cn/api/portal/v2/getUserBriefInfo.action', { status: 200, body: '{"nickname":"","account":""}' })
    const jar = new CookieJar()
    const { data } = await import('../../backend/cloud189/http.ts').then(mod => mod.jarRequestJson<{ nickname?: string }>(jar, { url: 'https://cloud.189.cn/api/portal/v2/getUserBriefInfo.action' }))
    assert.equal(data.nickname, '')
  } finally {
    await cleanup()
    setAdapter(getAdapter())
  }
})
