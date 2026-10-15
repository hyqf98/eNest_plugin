import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const core = async (slug) => import(pathToFileURL(resolve(root, 'plugins', 'com.enest.' + slug, 'src/js/core.js')))

const snippets = await core('snippets')
const markdown = await core('markdown')
const unit = await core('unit-convert')
if (!globalThis.crypto) globalThis.crypto = webcrypto
const totpCore = await core('totp')

// ———— snippets ————
test('snippets: 占位符提取、渲染与缺失保留', () => {
  assert.deepEqual(snippets.extractVars('const a = ${name}; ${count} ${name}'), ['name', 'count'])
  assert.deepEqual(snippets.extractVars('$name ${} ${1abc}'), [])
  assert.equal(snippets.renderVars('Hi ${user}, id=${user}-${id}', { user: 'A', id: 7 }), 'Hi A, id=A-7')
  assert.equal(snippets.renderVars('keep ${missing}', {}), 'keep ${missing}')
})

test('snippets: 过滤排序与语言着色类', () => {
  const list = [
    { title: 'fetch 封装', content: 'fetch(url)', tags: ['网络'], useCount: 2, lastUsedAt: 10, updatedAt: 10 },
    { title: '排序工具', content: 'arr.sort()', tags: ['数组'], useCount: 2, lastUsedAt: 20, updatedAt: 5 },
    { title: 'hello', content: 'print()', tags: [], useCount: 0, lastUsedAt: 0, updatedAt: 99 },
  ]
  assert.deepEqual(snippets.filterSnippets(list, 'sort').map((s) => s.title), ['排序工具'])
  assert.deepEqual(snippets.filterSnippets(list, '网络').map((s) => s.title), ['fetch 封装'])
  assert.equal(snippets.filterSnippets(list, '').length, 3)
  assert.deepEqual(snippets.sortSnippets(list).map((s) => s.title), ['排序工具', 'fetch 封装', 'hello'])
  assert.equal(snippets.langClass('Python'), 'lang-py')
  assert.equal(snippets.langClass('bash'), 'lang-sh')
  assert.equal(snippets.langClass('cobol'), 'lang-other')
  assert.equal(snippets.langClass(''), '')
})

test('snippets: 归一化、导入解析与导出', () => {
  const s = snippets.normalizeSnippet({ title: ' x ', lang: 'JS', tags: 'a, b，，c', content: 'y' }, 'id1')
  assert.equal(s.title, 'x')
  assert.equal(s.lang, 'JS')
  assert.deepEqual(s.tags, ['a', 'b', 'c'])
  assert.throws(() => snippets.normalizeSnippet({ content: 'x' }), /标题/)
  const parsed = snippets.parseImport('{"version":1,"snippets":[{"title":"t","content":"c"}]}')
  assert.equal(parsed.length, 1)
  assert.throws(() => snippets.parseImport('{"snippets":[]}'), /不含片段/)
  assert.throws(() => snippets.parseImport('nope'), SyntaxError)
  assert.equal(snippets.buildExport([{ id: 'a' }]).version, 1)
})

// ———— markdown ————
test('markdown: 标题/粗斜/行内码/链接/图片/自动链接', () => {
  const html = markdown.renderMarkdown('# 标题\n\n**粗** *斜* ***粗斜*** ~~删~~ `code` <>&\n\n[链](https://a.b) ![图](data:image/png;base64,x)\n\n见 https://auto.link 结束')
  assert.match(html, /<h1>标题<\/h1>/)
  assert.match(html, /<strong>粗<\/strong>/)
  assert.match(html, /<em>斜<\/em>/)
  assert.match(html, /<strong><em>粗斜<\/em><\/strong>/)
  assert.match(html, /<del>删<\/del>/)
  assert.match(html, /<code>code<\/code>/)
  assert.match(html, /&lt;&gt;&amp;/)
  assert.match(html, /<a href="https:\/\/a\.b"[^>]*>链<\/a>/)
  assert.match(html, /<img src="data:image\/png;base64,x" alt="图" \/>/)
  assert.match(html, /<a href="https:\/\/auto\.link"[^>]*>https:\/\/auto\.link<\/a>/)
})

test('markdown: 代码块/引用/列表/任务/表格/分隔线', () => {
  const html = markdown.renderMarkdown(
    '```js\nconst a = "<b>";\n```\n\n> 引用一行\n> 第二行\n\n- 甲\n- 乙\n\n1. one\n2. two\n\n- [ ] 未做\n- [x] 已做\n\n| A | B |\n| --- | ---: |\n| 1 | 2 |\n\n---\n',
  )
  assert.match(html, /<pre class="code-block" data-lang="js"><code><span class="tk-keyword">const<\/span> a = <span class="tk-str">&quot;&lt;b&gt;&quot;<\/span>;<\/code><\/pre>/)
  assert.match(html, /<blockquote><p>引用一行 第二行<\/p><\/blockquote>/)
  assert.match(html, /<ul class="ul"><li>甲<\/li><li>乙<\/li><\/ul>/)
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/)
  assert.match(html, /<ul class="task"><li class="task"><span class="box"[^>]*><\/span><span>未做<\/span><\/li><li class="task done">/)
  assert.match(html, /<th style="text-align:left">A<\/th>/)
  assert.match(html, /<td style="text-align:right">2<\/td>/)
  assert.match(html, /<hr \/>/)
})

test('markdown: 搜索高亮、统计与模板导出', () => {
  const note = { title: '会议记录', content: '第一段包含关键词 needles 在这里\n第二行' }
  const hit = markdown.searchHighlight(note, 'needle')
  assert.equal(hit.hit, true)
  assert.match(hit.title, /<mark>needle<\/mark>|会议记录/)
  assert.match(hit.snippet, /<mark>needle<\/mark>/)
  assert.equal(markdown.searchHighlight(note, 'zzz').hit, false)
  const s = markdown.stats('中文abc 文字')
  assert.equal(s.words, 5) // 中 文 + abc + 文 字（CJK 逐字 + 拉丁词）
  const out = markdown.noteToHtml('T', '# H')
  assert.match(out, /<title>T<\/title>/)
  assert.match(out, /<h1>H<\/h1>/)
  assert.equal(markdown.TEMPLATES.meeting.name, '会议记录')
})

// ———— unit-convert ————
test('单位换算矩阵：长度/质量/数据量/速度双向一致', () => {
  // 1 in = 2.54 cm
  assert.equal(unit.convertAll('length', 'in', 1).cm, 2.54)
  assert.equal(unit.convertAll('length', 'mi', 1).km, 1.609344)
  // 1 lb = 453.59237 g
  assert.equal(unit.convertAll('mass', 'lb', 1).g, 453.59237)
  // 1 jin(斤) = 500 g
  assert.equal(unit.convertAll('mass', 'jin', 1).g, 500)
  // 1 GB = 1024 MB
  assert.equal(unit.convertAll('data', 'GB', 1).MB, 1024)
  // 1 GB = 8 * 1024^3 bit
  assert.equal(unit.convertAll('data', 'GB', 1).bit, 8589934592)
  // 36 km/h = 10 m/s
  assert.equal(unit.convertAll('speed', 'kmh', 36).ms, 10)
  // 1 mu = 666.666... m2（round 到 10 位有效数字）
  const mu = unit.convertAll('area', 'mu', 1).m2
  assert.ok(Math.abs(mu - 2000 / 3) < 1e-9)
  // 往返一致：m → ft → m
  const toFt = unit.convertAll('length', 'm', 3).ft
  assert.ok(Math.abs(unit.convertAll('length', 'ft', toFt).m - 3) < 1e-9)
  // 无效输入返回空对象
  assert.deepEqual(unit.convertAll('length', 'm', NaN), {})
  assert.deepEqual(unit.convertAll('nope', 'm', 1), {})
})

test('温度换算公式与预设值', () => {
  const fromC = unit.convertAll('temp', 'C', 100)
  assert.equal(fromC.F, 212)
  assert.ok(Math.abs(fromC.K - 373.15) < 1e-9)
  const fromF = unit.convertAll('temp', 'F', 32)
  assert.equal(fromF.C, 0)
  assert.ok(Math.abs(unit.convertAll('temp', 'K', 0).C + 273.15) < 1e-9)
  assert.deepEqual(unit.convertAll('temp', 'X', 1), {})
})

test('进制解析、格式化与输入清洗', () => {
  assert.equal(unit.parseRadix('ff', 16), 255)
  assert.equal(unit.parseRadix('0xFF', 16), 255)
  assert.equal(unit.parseRadix('1010', 2), 10)
  assert.equal(unit.parseRadix('777', 8), 511)
  assert.equal(unit.parseRadix('129', 8), null)
  assert.equal(unit.parseRadix('2', 2), null)
  assert.equal(unit.parseRadix('', 10), null)
  assert.equal(unit.formatRadix(255, 16), 'FF')
  assert.equal(unit.formatRadix(10, 2, { group: true }), '1010')
  assert.equal(unit.formatRadix(-5, 2), '-101')
  assert.equal(unit.normalizeDigits('１２３'), '123')
  assert.equal(unit.parseInput('1,234.5'), 1234.5)
  assert.ok(Number.isNaN(unit.parseInput('abc')))
})

test('数字格式化：千分位与去尾零', () => {
  assert.equal(unit.formatNumber(1234567.5), '1,234,567.5')
  assert.equal(unit.formatNumber(0.1 + 0.2), '0.3')
  assert.equal(unit.formatNumber(-42), '-42')
  assert.equal(unit.formatNumber(Infinity), '—')
})

test('汇率：解析、cross rate、24h 缓存判断与回退', () => {
  const body = JSON.stringify({ result: 'success', rates: { USD: 1, CNY: 7.1, EUR: 0.9, JPY: 150 } })
  const parsed = unit.parseFxResponse(body, 1000)
  assert.equal(parsed.fetchedAt, 1000)
  assert.equal(parsed.rates.CNY, 7.1)
  assert.throws(() => unit.parseFxResponse('{"result":"error"}'), /格式异常/)
  assert.throws(() => unit.parseFxResponse('{"result":"success","rates":{"CNY":7}}'), /缺少 USD/)
  // 1 USD = 7.1 CNY；cross: base=EUR → CNY = 7.1/0.9
  assert.ok(Math.abs(unit.crossRate(parsed.rates, 'EUR', 'CNY') - 7.1 / 0.9) < 1e-12)
  const out = unit.fxConvert(parsed.rates, 'USD', 2)
  assert.equal(out.USD, 2)
  assert.equal(out.CNY, 14.2)
  assert.ok(unit.isCacheFresh({ rates: {}, fetchedAt: Date.now() }))
  assert.ok(!unit.isCacheFresh({ rates: {}, fetchedAt: Date.now() - 25 * 3600 * 1000 }))
  assert.ok(!unit.isCacheFresh(null))
  // 回退表含 USD/CNY/EUR/JPY/GBP/HKD/KRW… ≥ 12 币种
  assert.ok(Object.keys(unit.FX_FALLBACK_RATES).length >= 12)
  assert.ok(unit.FX_CURRENCIES.length >= 12)
})

test('人民币大写票据规则与中文数字', () => {
  assert.equal(unit.toRmbUpper(0), '零元整')
  assert.equal(unit.toRmbUpper(1024.5), '壹仟零贰拾肆元伍角整')
  assert.equal(unit.toRmbUpper(1024.55), '壹仟零贰拾肆元伍角伍分')
  assert.equal(unit.toRmbUpper(0.05), '伍分')
  assert.equal(unit.toRmbUpper(1.04), '壹元零肆分')
  assert.equal(unit.toRmbUpper(10), '壹拾元整')
  assert.equal(unit.toRmbUpper(1000000), '壹佰万元整')
  assert.equal(unit.toRmbUpper(100000000000), '壹仟亿元整')
  assert.equal(unit.toRmbUpper(1000000000000), '壹兆元整')
  assert.equal(unit.toRmbUpper(2005.3), '贰仟零伍元叁角整')
  assert.equal(unit.toRmbUpper(-3.5), '负叁元伍角整')
  // 105 元 → 壹佰零伍元整（跨段/段内零）
  assert.equal(unit.toRmbUpper(105), '壹佰零伍元整')
  assert.equal(unit.toRmbUpper(100000001), '壹亿零壹元整')
  // 中文数字（小写）
  assert.equal(unit.toChineseNumber(1024), '一千零二十四')
  assert.equal(unit.toChineseNumber(0), '零')
  assert.equal(unit.toChineseNumber(100000001), '一亿零一')
  assert.equal(unit.toChineseNumber(2005), '二千零五')
  assert.equal(unit.toChineseNumber(1000000000000), '一兆')
  assert.equal(unit.toChineseNumber(-7), '负七')
  // 超限返回 —
  assert.equal(unit.toRmbUpper(1e17), '—')
})

// ———— totp ————
test('TOTP base32 编解码往返与非法输入', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 77])
  assert.deepEqual(totpCore.base32Decode(totpCore.base32Encode(bytes)), bytes)
  // RFC 4648 测试向量
  assert.equal(totpCore.base32Encode(new TextEncoder().encode('foobar')), 'MZXW6YTBOI======')
  assert.equal(new TextDecoder().decode(totpCore.base32Decode('MZXW6YTBOI======')), 'foobar')
  // 容忍空格、小写、无 padding
  assert.equal(new TextDecoder().decode(totpCore.base32Decode('mzxw6ytboi')), 'foobar')
  assert.throws(() => totpCore.base32Decode('abc1'), /base32/)
  assert.throws(() => totpCore.base32Decode(''), /为空/)
})

test('TOTP RFC 6238 测试向量（SHA1/SHA256/SHA512，8 位）', async () => {
  // RFC 6238 附录 B：secret = "12345678901234567890" / 32 字节 / 64 字节（ASCII）
  const enc = (s) => totpCore.base32Encode(new TextEncoder().encode(s))
  const secret20 = enc('12345678901234567890')
  const secret32 = enc('12345678901234567890123456789012')
  const secret64 = enc('1234567890123456789012345678901234567890123456789012345678901234')
  const sha1Vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]
  for (const [t, expect] of sha1Vectors) {
    const code = await totpCore.totp(secret20, { digits: 8, period: 30, algorithm: 'SHA1', forTime: t * 1000 })
    assert.equal(code, expect, `SHA1 t=${t}`)
  }
  const sha256Vectors = [
    [59, '46119246'],
    [1111111109, '68084774'],
    [1111111111, '67062674'],
    [1234567890, '91819424'],
    [2000000000, '90698825'],
    [20000000000, '77737706'],
  ]
  for (const [t, expect] of sha256Vectors) {
    const code = await totpCore.totp(secret32, { digits: 8, period: 30, algorithm: 'SHA256', forTime: t * 1000 })
    assert.equal(code, expect, `SHA256 t=${t}`)
  }
  const sha512Vectors = [
    [59, '90693936'],
    [1111111109, '25091201'],
    [1111111111, '99943326'],
    [1234567890, '93441116'],
    [2000000000, '38618901'],
    [20000000000, '47863826'],
  ]
  for (const [t, expect] of sha512Vectors) {
    const code = await totpCore.totp(secret64, { digits: 8, period: 30, algorithm: 'SHA512', forTime: t * 1000 })
    assert.equal(code, expect, `SHA512 t=${t}`)
  }
})

test('TOTP 6 位缺省、60 秒周期、剩余秒数与非法算法', async () => {
  const secret20 = totpCore.base32Encode(new TextEncoder().encode('12345678901234567890'))
  // 同一计数器下 6 位 = 8 位向量的低 6 位
  const code6 = await totpCore.totp(secret20, { digits: 6, forTime: 59 * 1000 })
  assert.equal(code6, '287082')
  // 60 秒周期：t=59 → counter=0（30s 周期 t=59 是 counter=1），取 SHA1 8 位 counter=0 已由 RFC 覆盖
  const code60 = await totpCore.totp(secret20, { digits: 8, period: 60, forTime: 59 * 1000 })
  const code60Check = await totpCore.totp(secret20, { digits: 8, period: 60, counter: 0 })
  assert.equal(code60, code60Check)
  assert.equal(totpCore.remainingSeconds(59 * 1000, 30), 1)
  assert.equal(totpCore.remainingSeconds(60 * 1000, 30), 30)
  assert.equal(totpCore.periodStart(591234, 30), 570000)
  await assert.rejects(() => totpCore.totp('JBSW', { algorithm: 'MD5' }), /不支持的算法/)
})

test('otpauth 解析与生成往返', () => {
  const parsed = totpCore.parseOtpauth('otpauth://totp/GitHub:me%40x.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=SHA256')
  assert.equal(parsed.account, 'me@x.com')
  assert.equal(parsed.issuer, 'GitHub')
  assert.equal(parsed.digits, 8)
  assert.equal(parsed.period, 60)
  assert.equal(parsed.algorithm, 'SHA256')
  const noIssuer = totpCore.parseOtpauth('otpauth://totp/me@x.com?secret=JBSWY3DPEHPK3PXP')
  assert.equal(noIssuer.account, 'me@x.com')
  assert.equal(noIssuer.issuer, '')
  assert.equal(noIssuer.digits, 6)
  assert.throws(() => totpCore.parseOtpauth('https://x.com'), /otpauth/)
  assert.throws(() => totpCore.parseOtpauth('otpauth://hotp/x?secret=AB'), /totp/)
  assert.throws(() => totpCore.parseOtpauth('otpauth://totp/x'), /secret/)
  const entry = totpCore.normalizeEntry(parsed)
  const round = totpCore.parseOtpauth(totpCore.toOtpauth(entry))
  assert.equal(round.secret, parsed.secret)
  assert.equal(round.issuer, 'GitHub')
  assert.throws(() => totpCore.normalizeEntry({ account: 'a', secret: '!!' }), /base32/)
})

test('加密备份：AES-GCM 往返、错误口令拒绝', async () => {
  const payload = { entries: [{ account: 'a', secret: 'JBSWY3DPEHPK3PXP' }] }
  const json = await totpCore.encryptBackup(payload, 'pass-123')
  assert.match(json, /"format":"enest-totp-backup"/)
  const back = await totpCore.decryptBackup(json, 'pass-123')
  assert.deepEqual(back, payload)
  await assert.rejects(() => totpCore.decryptBackup(json, 'wrong-pass'), /口令错误/)
  await assert.rejects(() => totpCore.encryptBackup(payload, '123'), /至少 6 位/)
  await assert.rejects(() => totpCore.decryptBackup('{"format":"other"}', 'pass-123'), /备份文件/)
})
