import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const core = await import(pathToFileURL(resolve(root, 'src/js/core.js')))

test('extractVars 去重保序并忽略转义', () => {
  assert.deepEqual(core.extractVars('${a} ${b} ${a}'), ['a', 'b'])
  assert.deepEqual(core.extractVars('$$ {nope} ${ok_1}'), ['ok_1'])
  assert.deepEqual(core.extractVars(''), [])
})

test('renderVars 缺失变量保留原样', () => {
  assert.equal(core.renderVars('x=${a} y=${b}', { a: '1' }), 'x=1 y=${b}')
})

test('filterSnippets 覆盖标题、内容、标签与分组', () => {
  const list = [
    { title: 'fetch 封装', content: 'await fetch(url)', tags: ['网络'], group: '前端' },
    { title: 'ls 别名', content: 'alias ll="ls -la"', tags: [], group: '终端' },
  ]
  assert.equal(core.filterSnippets(list, 'fetch').length, 1)
  assert.equal(core.filterSnippets(list, '网络').length, 1)
  assert.equal(core.filterSnippets(list, '终端').length, 1)
  assert.equal(core.filterSnippets(list, '').length, 2)
})

test('分组：归一、统计与聚合，未分组排最后', () => {
  const list = [
    { title: 'a', content: '', tags: [], group: '前端' },
    { title: 'b', content: '', tags: [], group: '' },
    { title: 'c', content: '', tags: [], group: '终端' },
    { title: 'd', content: '', tags: [], group: '前端 ' },
  ]
  assert.equal(core.groupOf(list[1]), '未分组')
  assert.deepEqual(core.collectGroups(list), ['前端', '终端', '未分组'])
  assert.deepEqual([...core.groupCounts(list).entries()], [['前端', 2], ['未分组', 1], ['终端', 1]])
  const map = core.groupBy(list)
  assert.equal(map.get('前端').length, 2)
  assert.equal(core.validGroupName(' 网络请求 \n'), '网络请求')
  assert.equal(core.validGroupName('  '), '')
})

test('tokenizeCode：js 关键字、字符串、注释、数字与函数调用', () => {
  const tokens = core.tokenizeCode('const url = "http://x"; // note\nfetch(url)', 'c')
  const by = (t) => tokens.filter((x) => x.type === t).map((x) => x.value)
  assert.ok(by('keyword').includes('const'))
  assert.ok(by('str').some((v) => v.includes('"http://x"')))
  assert.ok(by('comment').some((v) => v.includes('// note')))
  assert.ok(by('fn').includes('fetch'))
  // 片段拼接可无损还原原文
  assert.equal(tokens.map((t) => t.value).join(''), 'const url = "http://x"; // note\nfetch(url)')
})

test('tokenizeCode：python 与 sh 用 # 注释，markup 处理标签', () => {
  const py = core.tokenizeCode('def f():  # 注释\n return None', 'py')
  assert.ok(py.some((t) => t.type === 'keyword' && t.value.includes('def')))
  assert.ok(py.some((t) => t.type === 'comment' && t.value.includes('# 注释')))
  const sh = core.tokenizeCode('echo "hi" # done', 'sh')
  assert.ok(sh.some((t) => t.type === 'comment' && t.value.includes('# done')))
  const html = core.tokenizeCode('<div class="a">x</div>', 'markup')
  assert.ok(html.some((t) => t.type === 'keyword' && t.value.includes('<div')))
  assert.ok(html.some((t) => t.type === 'str' && t.value.includes('"a"')))
})

test('highlightToHtml 输出转义安全的 span 标记', () => {
  const html = core.highlightToHtml('const s = "<b>"', 'c')
  assert.ok(!html.includes('<b>'))
  assert.ok(html.includes('&lt;b&gt;'))
  assert.ok(html.includes('tk-keyword'))
})

test('排序与归一化：使用次数置顶、分组字段保留', () => {
  const a = core.normalizeSnippet({ title: '低频', content: 'a', useCount: 1 })
  const b = core.normalizeSnippet({ title: '高频', content: 'b', useCount: 9, group: '前端' })
  const sorted = core.sortSnippets([a, b])
  assert.equal(sorted[0].title, '高频')
  assert.equal(b.group, '前端')
  const round = core.parseImport(JSON.stringify(core.buildExport([b])))
  assert.equal(round[0].group, '前端')
})

// —— 折叠区间：computeFoldRanges —— //
test('computeFoldRanges: 嵌套/兄弟块与深度', () => {
  const src = [
    'function a() {', // 0
    '  const b = 1', // 1
    '  if (b) {', // 2
    '    return 2', // 3
    '  }', // 4
    '}', // 5
    'const c = 3', // 6
  ].join('\n')
  const folds = core.computeFoldRanges(src)
  const outer = folds.find((f) => f.start === 0)
  assert.equal(outer.end, 5)
  assert.equal(outer.depth, 0)
  const inner = folds.find((f) => f.start === 2)
  assert.equal(inner.end, 4)
  assert.equal(inner.depth, 1)
  assert.ok(!folds.some((f) => f.start === 6))
})

test('computeFoldRanges: 空行不算缩进', () => {
  const src = 'top\n  a\n\n  b\n\ntail'
  const folds = core.computeFoldRanges(src)
  assert.equal(folds.length, 1)
  assert.equal(folds[0].start, 0)
  assert.equal(folds[0].end, 3)
})

test('computeFoldRanges: tab 缩进按 4 宽计算', () => {
  const src = 'def f():\n\tx = 1\n\tif x:\n\t\treturn x\n'
  const folds = core.computeFoldRanges(src)
  assert.equal(folds.find((f) => f.start === 0)?.end, 3)
  assert.equal(folds.find((f) => f.start === 2)?.end, 3)
})

test('computeFoldRanges: 超限返回 null 供降级', () => {
  const long = Array.from({ length: 1501 }, (_, i) => `line ${i}`).join('\n')
  assert.equal(core.computeFoldRanges(long), null)
  assert.equal(core.computeFoldRanges(long.slice(0, 100)).length, 0)
})

// —— 按行高亮：highlightLines —— //
test('highlightLines: 跨行 token 正确分段且逐行拼接无损', () => {
  const src = 'const s = `a\nb`\n/* c\nd */\nconst x = 1'
  const lines = core.highlightLines(src, 'c')
  assert.equal(lines.length, 5)
  assert.match(lines[0], /tk-str/)
  assert.match(lines[1], /tk-str/)
  assert.match(lines[2], /tk-comment/)
  assert.match(lines[3], /tk-comment/)
  assert.match(lines[4], /tk-num/)
  const unescape = (h) =>
    h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  assert.equal(lines.map(unescape).join('\n'), src)
})

test('highlightLines: HTML 转义保底（字符串含标签）', () => {
  const lines = core.highlightLines('const a = "<b>"', 'c')
  assert.ok(lines[0].includes('&lt;b&gt;'))
})

// —— tokenizer 增强 —— //
test('tokenizer: 新增关键字与 sql scope', () => {
  const tokens = core.tokenizeCode('satisfies keyof as from', 'c')
  assert.ok(tokens.filter((t) => t.type === 'keyword').length >= 3)
  const sql = core.tokenizeCode('-- note\nselect * from t where id = 1', 'sql')
  assert.equal(sql.find((t) => t.value === '-- note')?.type, 'comment')
  assert.equal(sql.find((t) => t.value === 'select')?.type, 'keyword')
  assert.equal(sql.find((t) => t.value === 'from')?.type, 'keyword')
  assert.equal(core.langScope('SQL'), 'sql')
  const joined = sql.map((t) => t.value).join('')
  assert.equal(joined, '-- note\nselect * from t where id = 1')
})
