/** 纯逻辑自测：TOTP（RFC 6238 向量）、otpauth 解析、password-kit 熵/密码短语、clipboard 文本变换。
    运行：node --test plugins-logic.test.mjs （需 Node 18+，WebCrypto 走 globalThis.crypto） */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const totpCore = await import(join(root, 'plugins/com.enest.totp/src/js/core.js'))
const pwCore = await import(join(root, 'plugins/com.enest.password-kit/src/js/core.mjs'))
const tk = await import(join(root, 'plugins/com.enest.clipboard/src/js/textkit.js'))

// —— RFC 6238 附录 B 测试向量（secret = "12345678901234567890…" 的 ASCII）——
const secret8 = Buffer.from('12345678901234567890').toString('utf8')
// base32 of ascii "12345678901234567890"
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
assert.equal(Buffer.from(totpCore.base32Decode(SECRET_B32)).toString('utf8'), secret8)

const T = (seconds) => seconds * 1000
// SHA1 8位 向量（RFC 6238 B）
const sha1Vectors = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]
for (const [time, expect] of sha1Vectors) {
  test(`RFC6238 SHA1 T=${time} → ${expect}`, async () => {
    const code = await totpCore.totp(SECRET_B32, { digits: 8, period: 30, algorithm: 'SHA1', forTime: T(time) })
    assert.equal(code, expect)
  })
}

// SHA256 / SHA512 向量（secret 分别为 32 / 64 字节 ASCII）
const SECRET_B32_256 = totpCore.base32Encode(Buffer.from('12345678901234567890123456789012', 'utf8'))
const sha256Vectors = [
  [59, '46119246'],
  [1111111109, '68084774'],
  [1111111111, '67062674'],
  [1234567890, '91819424'],
  [2000000000, '90698825'],
  [20000000000, '77737706'],
]
for (const [time, expect] of sha256Vectors) {
  test(`RFC6238 SHA256 T=${time} → ${expect}`, async () => {
    const code = await totpCore.totp(SECRET_B32_256, { digits: 8, period: 30, algorithm: 'SHA256', forTime: T(time) })
    assert.equal(code, expect)
  })
}

const SECRET_B32_512 = totpCore.base32Encode(Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'utf8'))
const sha512Vectors = [
  [59, '90693936'],
  [1111111109, '25091201'],
  [1111111111, '99943326'],
  [1234567890, '93441116'],
  [2000000000, '38618901'],
  [20000000000, '47863826'],
]
for (const [time, expect] of sha512Vectors) {
  test(`RFC6238 SHA512 T=${time} → ${expect}`, async () => {
    const code = await totpCore.totp(SECRET_B32_512, { digits: 8, period: 30, algorithm: 'SHA512', forTime: T(time) })
    assert.equal(code, expect)
  })
}

// —— 周期/剩余/下码 ——
test('remainingSeconds / periodStart / nextCodeAt', () => {
  assert.equal(totpCore.remainingSeconds(T(120), 30), 30)
  assert.equal(totpCore.remainingSeconds(T(125), 30), 25)
  assert.equal(totpCore.periodStart(T(125), 30), T(120))
  assert.equal(totpCore.nextCodeAt(T(125), 30), T(150))
  assert.equal(totpCore.nextCodeAt(T(125), 60), T(180))
})

// —— otpauth 解析 ——
test('parseOtpauth：issuer 参数优先 + 参数齐全', () => {
  const parsed = totpCore.parseOtpauth('otpauth://totp/GitHub:me%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=SHA256')
  assert.equal(parsed.account, 'me@example.com')
  assert.equal(parsed.issuer, 'GitHub')
  assert.equal(parsed.secret, 'JBSWY3DPEHPK3PXP')
  assert.equal(parsed.digits, 8)
  assert.equal(parsed.period, 60)
  assert.equal(parsed.algorithm, 'SHA256')
})
test('parseOtpauth：label 前缀兜底 issuer、非法输入报错', () => {
  const parsed = totpCore.parseOtpauth('otpauth://totp/MyApp:alice?secret=JBSW')
  assert.equal(parsed.issuer, 'MyApp')
  assert.equal(parsed.account, 'alice')
  assert.throws(() => totpCore.parseOtpauth('https://example.com'), /otpauth/)
  assert.throws(() => totpCore.parseOtpauth('otpauth://hotp/x?secret=AB'), /hotp/)
  assert.throws(() => totpCore.parseOtpauth('otpauth://totp/x'), /secret/)
})
test('toOtpauth ↔ parseOtpauth 往返', () => {
  const entry = { account: 'me@x.com', issuer: 'Acme', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' }
  const round = totpCore.parseOtpauth(totpCore.toOtpauth(entry))
  assert.equal(round.account, entry.account)
  assert.equal(round.issuer, entry.issuer)
  assert.equal(round.secret, entry.secret)
})

// —— password-kit ——
test('熵估计与生成约束', () => {
  assert.equal(pwCore.entropyEstimate({ length: 16, sets: ['lower', 'upper', 'digit', 'symbol'] }), 99)
  assert.throws(() => pwCore.generatePassword({ length: 3 }), /6–128/)
  assert.throws(() => pwCore.generatePassword({ length: 8, sets: [] }), /至少选择一种字符集/)
})
test('生成密码满足每类至少一个字符', () => {
  for (let i = 0; i < 30; i++) {
    const pw = pwCore.generatePassword({ length: 12, sets: ['lower', 'upper', 'digit', 'symbol'] })
    assert.equal(pw.length, 12)
    assert.match(pw, /[a-z]/)
    assert.match(pw, /[A-Z]/)
    assert.match(pw, /[0-9]/)
    assert.ok(/[!@#$%^&*_\-+=?]/.test(pw), '含符号')
  }
})
test('PIN：长度与纯数字', () => {
  const pin = pwCore.generatePin(8)
  assert.equal(pin.length, 8)
  assert.match(pin, /^\d{8}$/)
  assert.throws(() => pwCore.generatePin(2), /4–16/)
  assert.equal(pwCore.pinEntropy(6), 19)
})
test('密码短语：词数、分隔符、熵', () => {
  const phrase = pwCore.generatePassphrase({ words: 5, separator: '.', capitalize: true })
  const parts = phrase.split('.')
  assert.ok(parts.length === 5 || parts.length === 6, '5 词或带数字后缀 6 段')
  const words = parts.filter((p) => /^[A-Z][a-z]+$/.test(p))
  assert.equal(words.length, 5)
  for (const w of words) assert.ok(pwCore.PASSPHRASE_WORDLIST.includes(w.toLowerCase()), '词在词表内')
  assert.ok(pwCore.passphraseEntropy({ words: 5 }) >= 59)
  // 空分隔符
  const joined = pwCore.generatePassphrase({ words: 3, separator: '', appendNumber: false })
  assert.doesNotMatch(joined, /[.\-_ ]/)
})
test('词表无重复且规模稳定', () => {
  const list = pwCore.PASSPHRASE_WORDLIST
  assert.equal(new Set(list).size, list.length)
  assert.ok(list.length > 1400)
})
test('检查器：guessEntropy 与规则提示', () => {
  assert.ok(pwCore.guessEntropy('Tr0ub4dour&3') > 40)
  assert.equal(pwCore.guessEntropy(''), 0)
  assert.ok(pwCore.guessEntropy('123456') < 30)
  const issues = pwCore.strengthIssues('123456')
  assert.ok(issues.some((s) => s.includes('12 位')))
  assert.ok(pwCore.strengthIssues('abcdefgh1').some((s) => s.includes('大写')))
  assert.ok(pwCore.crackTimeEstimate(128).seconds > pwCore.crackTimeEstimate(40).seconds)
})

// —— clipboard textkit ——
test('formatJson：格式化与压缩、非法输入报错', () => {
  assert.equal(tk.formatJson('{"a":1}'), '{\n  "a": 1\n}')
  assert.equal(tk.formatJson(' { "a" : [ 1 , 2 ] } ', { minify: true }), '{"a":[1,2]}')
  assert.throws(() => tk.formatJson('{bad}'), SyntaxError)
})
test('uniqueLines / sortLines', () => {
  assert.equal(tk.uniqueLines('a\nb\na\n b \nc'), 'a\nb\nc')
  assert.equal(tk.uniqueLines('a\n\nb', { dropEmpty: true }), 'a\nb')
  assert.equal(tk.sortLines('b\na\nc'), 'a\nb\nc')
  assert.equal(tk.sortLines('b\na\nc', 'desc'), 'c\nb\na')
})
test('changeCase 六种', () => {
  assert.equal(tk.changeCase('hello world', 'upper'), 'HELLO WORLD')
  assert.equal(tk.changeCase('HeLLo World', 'lower'), 'hello world')
  assert.equal(tk.changeCase('hello world', 'camel'), 'helloWorld')
  assert.equal(tk.changeCase('helloWorld', 'snake'), 'hello_world')
  assert.equal(tk.changeCase('hello world', 'kebab'), 'hello-world')
  assert.equal(tk.changeCase('hello world', 'title'), 'Hello World')
})
test('stripFormatting / regexReplace', () => {
  assert.equal(tk.stripFormatting('  a \n\n b\tc  '), 'a b c')
  assert.equal(tk.regexReplace('a1b22c333', '\\d+', '-'), 'a-b-c-')
  assert.equal(tk.regexReplace('john smith', '(\\w+) (\\w+)', '$2 $1'), 'smith john')
  assert.throws(() => tk.regexReplace('x', '(', 'y'), /正则表达式无效/)
  assert.throws(() => tk.regexReplace('x', '', 'y'), /为空/)
})
test('normalizeSnippet：默认标题与截断', () => {
  const s = tk.normalizeSnippet({ body: '  first line\nsecond' })
  assert.equal(s.title, 'first line')
  assert.equal(s.body, '  first line\nsecond')
  assert.throws(() => tk.normalizeSnippet({ body: '   ' }), /为空/)
  const long = tk.normalizeSnippet({ body: 'x'.repeat(6000), maxBody: 5000 })
  assert.equal(long.body.length, 5000)
})
