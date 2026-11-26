import test from 'node:test'
import assert from 'node:assert/strict'
import { blockAt, parseBlocks } from '../src/cm/blocks.js'

const F = String.fromCharCode(96, 96, 96)
const doc = ['---', 'title: t', '---', '', '# H1', '', 'p1', 'p2', '', F + 'js', 'let a = 1', F, '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '- x', '- y', '', '> q1', '> q2', '', '$$e=mc^2$$', '', '$', 'a+b', '$$', '', 'end.'].join('\n')

test('parseBlocks：覆盖全部块类型且偏移一致', () => {
  const blocks = parseBlocks(doc)
  const types = blocks.map((b) => b.type)
  assert.ok(types.includes('meta'))
  assert.ok(types.includes('heading'))
  assert.ok(types.includes('paragraph'))
  assert.ok(types.includes('fence'))
  assert.ok(types.includes('table'))
  assert.ok(types.includes('list'))
  assert.ok(types.includes('quote'))
  assert.ok(types.includes('math'))
  for (const b of blocks) assert.equal(doc.slice(b.from, b.to), b.text, `offset mismatch: ${b.type}`)
})

test('parseBlocks：单行闭合数学块', () => {
  const blocks = parseBlocks('$$e=mc^2$$\n\ntail')
  assert.equal(blocks[0].type, 'math')
  assert.equal(blocks[0].text, '$$e=mc^2$$')
})

test('parseBlocks：未闭合 fence 吞到文档尾', () => {
  const blocks = parseBlocks('text\n\n' + F + 'js\nunclosed')
  const fence = blocks.find((b) => b.type === 'fence')
  assert.ok(fence)
  assert.equal(fence.to, ('text\n\n' + F + 'js\nunclosed').length)
})

test('blockAt：命中包含光标的块', () => {
  const blocks = parseBlocks(doc)
  assert.equal(blockAt(blocks, 1).type, 'meta')
})

test('多行 Setext 标题包含下划线；引用和段落之间的真空行不归引用块', () => {
  const text = '长标题\n第二行\n---\n\n> 引用\n\n> 下一条'
  const [heading, first, second] = parseBlocks(text)
  assert.deepEqual([heading.type, heading.style, heading.level, heading.text], ['heading', 'setext', 2, '长标题\n第二行\n---'])
  assert.equal(blockAt([heading, first, second], text.lastIndexOf('\n\n') + 1), null)
})

test('表头列数必须匹配；转义竖线不分列；缩进四格的围栏不能提前关闭代码块', () => {
  assert.equal(parseBlocks('| a | b |\n| -- |')[0].type, 'paragraph')
  assert.equal(parseBlocks('| a\\|b |\n| -- |')[0].type, 'table')
  const code = '```txt\n    ```\n# 仍然是代码\n```'
  assert.equal(parseBlocks(code)[0].text, code)
})

test('HTML 原始文本块中的空行保留，闭合标签之外的正文仍然可编辑', () => {
  const [pre, next] = parseBlocks('<pre>开头\n\n尾</pre>\n**正文**')
  assert.equal(pre.text, '<pre>开头\n\n尾</pre>')
  assert.equal(next.type, 'paragraph')
})
