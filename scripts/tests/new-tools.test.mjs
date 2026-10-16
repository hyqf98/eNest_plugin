import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const core = async (slug) => import(pathToFileURL(resolve(root, 'plugins', slug, 'src/js/core.js')))

const markdown = await core('markdown')
const unit = await core('unit-convert')
if (!globalThis.crypto) globalThis.crypto = webcrypto

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
