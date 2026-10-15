import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const core = await import(pathToFileURL(resolve(root, 'src/js/core.js')))

test('renderMarkdown：标题/列表/任务清单/表格/引用', () => {
  const html = core.renderMarkdown('# T\n\n- a\n- b\n\n- [ ] 待办\n- [x] 完成\n\n| A | B |\n| --- | :-: |\n| 1 | 2 |\n\n> 引用')
  assert.match(html, /<h1>T<\/h1>/)
  assert.match(html, /<ul class="ul"><li>a<\/li><li>b<\/li><\/ul>/)
  assert.match(html, /<ul class="task"><li class="task"><span class="box"/)
  assert.match(html, /<li class="task done">/)
  assert.match(html, /<th style="text-align:left">A<\/th>/)
  assert.match(html, /<td style="text-align:center">2<\/td>/)
  assert.match(html, /<blockquote><p>引用<\/p><\/blockquote>/)
})

test('renderMarkdown：GFM 高亮标记 ==text==', () => {
  assert.match(core.renderMarkdown('==重点=='), /<mark>重点<\/mark>/)
  assert.doesNotMatch(core.renderMarkdown('a=b=c'), /<mark>/)
})

test('renderMarkdown：围栏代码块按语言高亮，未知语言纯转义', () => {
  const js = core.renderMarkdown('```js\nconst n = 42 // note\n```')
  assert.match(js, /<pre class="code-block" data-lang="js">/)
  assert.match(js, /tk-keyword">const</)
  assert.match(js, /tk-comment">\/\/ note</)
  const unknown = core.renderMarkdown('```\n<b>&</b>\n```')
  assert.match(unknown, /&lt;b&gt;/)
  assert.doesNotMatch(unknown, /tk-keyword/)
})

test('代码高亮：片段拼接无损还原，输出转义安全', () => {
  const src = 'def f(x): # 中文注释\n return f"{x}"'
  const tokens = core.highlightToHtml(src, 'py')
  assert.ok(tokens.includes('tk-keyword'))
  assert.ok(tokens.includes('tk-comment'))
  const plain = core.highlightToHtml('<b>', '')
  assert.equal(plain, '&lt;b&gt;')
})

test('outline：提取标题与行号，忽略代码块内 #，行首尾 # 修剪', () => {
  const md = '# 顶部\n\n正文\n```bash\n# 这不是标题\n```\n## 子标题 ##\n### 三级'
  const items = core.outline(md)
  assert.deepEqual(
    items.map((i) => [i.level, i.text, i.line]),
    [[1, '顶部', 0], [2, '子标题', 6], [3, '三级', 7]],
  )
  const depths = core.outlineDepth(items)
  assert.deepEqual(depths.map((d) => d.depth), [0, 1, 2])
  assert.deepEqual(core.outline(''), [])
})

test('stats 与 readingTime：CJK 计字、最低 1 分钟', () => {
  const s = core.stats('你好世界 hello world 42')
  assert.equal(s.words, 7) // 4 CJK + 2 英文词 + 数字 1
  assert.equal(core.stats('').words, 0)
  assert.ok(core.readingTime('短文') >= 1)
  assert.ok(core.readingTime('字'.repeat(2600)) >= 10)
})

test('transforms：包裹/行前缀/块插入返回正确 caret', () => {
  assert.deepEqual(core.transformWrap('abc', 0, 3, '**'), { text: '**abc**', caret: 7 })
  assert.deepEqual(core.transformLinePrefix('a\nb', 2, '- '), { text: 'a\n- b', caret: 4 })
  const block = core.transformBlock('x', 0, 1, '```\n\n```')
  assert.match(block.text, /```\nx\n```/)
})

test('normalizeNote：默认分组收件箱、附件裁剪', () => {
  const n = core.normalizeNote({ title: 't' })
  assert.equal(n.group, '收件箱')
  const longKey = 'k'.repeat(100)
  const a = core.normalizeNote({ title: 't', attachments: { [longKey]: 'x'.repeat(500) } })
  assert.equal(Object.keys(a.attachments)[0].length, 80)
  assert.equal(Object.values(a.attachments)[0].length, 200)
})

test('noteToHtml：完整文档，含暗色适配', () => {
  const html = core.noteToHtml('标题', '# Hello')
  assert.match(html, /<!doctype html>/)
  assert.match(html, /<title>标题<\/title>/)
  assert.match(html, /<h1>Hello<\/h1>/)
  assert.match(html, /prefers-color-scheme:dark/)
})
