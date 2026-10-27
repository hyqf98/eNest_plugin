import test from 'node:test'
import assert from 'node:assert/strict'

/* 复刻 src/cm/clickMap.js 的实现（纯函数，不依赖 CodeMirror 运行时） */
function clampToBlock(pos, from, to) {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const n = Number(pos)
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

function offsetOfLine(blockText, lineIndex) {
  const text = String(blockText ?? '')
  if (!text) return 0
  const lines = text.split('\n')
  const raw = Math.trunc(Number(lineIndex))
  const idx = Math.min(Math.max(Number.isFinite(raw) ? raw : 0, 0), lines.length - 1)
  let offset = 0
  for (let i = 0; i < idx; i++) offset += lines[i].length + 1
  return offset
}

function cellSourceOffset(lineText, cellIndex) {
  const line = String(lineText ?? '')
  const raw = Math.trunc(Number(cellIndex))
  const want = Number.isFinite(raw) && raw > 0 ? raw : 0
  const segments = []
  let start = 0
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue }
    if (line[i] === '|') { segments.push([start, i]); start = i + 1 }
  }
  segments.push([start, line.length])
  if (segments.length > 1 && line.slice(segments[0][0], segments[0][1]).trim() === '') segments.shift()
  if (segments.length > 1 && line.slice(segments[segments.length - 1][0], segments[segments.length - 1][1]).trim() === '') segments.pop()
  const seg = segments[Math.min(want, segments.length - 1)]
  if (!seg) return 0
  let offset = seg[0]
  while (offset < seg[1] && /\s/.test(line[offset])) offset++
  return offset
}

function codeSourceOffset(blockText, codeOffset) {
  const text = String(blockText ?? '')
  const firstLine = text.split('\n', 1)[0] ?? ''
  const base = firstLine.length + 1
  const off = Math.max(0, Math.trunc(Number(codeOffset)) || 0)
  return base + Math.min(off, Math.max(0, text.length - base))
}

function needsScrollIntoView(caretRect, viewportRect, margin = 4) {
  if (!caretRect || !viewportRect) return true
  return caretRect.top < viewportRect.top + margin || caretRect.bottom > viewportRect.bottom - margin
}

/* ---------------- clampToBlock ---------------- */

test('clampToBlock：范围内原样返回（取整）', () => {
  assert.equal(clampToBlock(12.4, 10, 20), 12)
  assert.equal(clampToBlock(15, 10, 20), 15)
})

test('clampToBlock：越界收敛到块起止', () => {
  assert.equal(clampToBlock(5, 10, 20), 10)
  assert.equal(clampToBlock(99, 10, 20), 20)
})

test('clampToBlock：非法位置回落到块起点，from/to 反序也能处理', () => {
  assert.equal(clampToBlock(NaN, 10, 20), 10)
  assert.equal(clampToBlock(undefined, 10, 20), 10)
  assert.equal(clampToBlock(15, 20, 10), 15)
})

/* ---------------- offsetOfLine ---------------- */

test('offsetOfLine：按行累加含换行符', () => {
  const text = 'ab\ncde\nf'
  assert.equal(offsetOfLine(text, 0), 0)
  assert.equal(offsetOfLine(text, 1), 3)  // 'ab\n' → 3
  assert.equal(offsetOfLine(text, 2), 7)  // 'ab\ncde\n' → 7
})

test('offsetOfLine：越界与空文本', () => {
  assert.equal(offsetOfLine('a\nb', 99), 2)
  assert.equal(offsetOfLine('a\nb', -5), 0)
  assert.equal(offsetOfLine('', 3), 0)
})

/* ---------------- codeSourceOffset：点 java 后面的场景 ---------------- */

test('代码块点击：渲染态偏移换算到源码偏移（跳过 ```java 行）', () => {
  const block = '```java\npublic class A {}\n```'
  // 首行 '```java' 长度 7，+1 = 8 → 代码正文从块内偏移 8 开始
  assert.equal(codeSourceOffset(block, 0), 8)
  // 点在渲染态第 0 行第 6 列（"public" 之后）→ 源码 8+6
  assert.equal(codeSourceOffset(block, 6), 14)
  // 点在第一行末尾 → 对应源码第一行末尾
  const firstLine = 'public class A {}'
  assert.equal(codeSourceOffset(block, firstLine.length), 8 + firstLine.length)
})

test('代码块点击：第二行偏移跨过换行符', () => {
  const block = '```js\na\nbb\n```'
  const rendered = 'a\nbb'
  const codeOffset = offsetOfLine(rendered, 1) + 1 // 第二行第 1 列
  assert.equal(codeSourceOffset(block, codeOffset), '```js\n'.length + 'a\n'.length + 1)
})

test('代码块点击：偏移超出代码正文时收敛到块尾前', () => {
  const block = '```js\nab\n```'
  const max = block.length - 4 // 去掉尾部 ```（3 字符 + 前面的换行由 clamp 处理）
  assert.ok(codeSourceOffset(block, 9999) <= block.length)
  assert.ok(codeSourceOffset(block, 9999) >= max - 4)
})

/* ---------------- cellSourceOffset：表格单元格 ---------------- */

test('表格点击：单元格内容起始列（跳过竖线与空白）', () => {
  const line = '| 姓名 | 年龄 |'
  assert.equal(cellSourceOffset(line, 0), 2)  // '姓名' 起点
  assert.equal(cellSourceOffset(line, 1), 7)  // '年龄' 起点
})

test('表格点击：无首尾竖线的写法', () => {
  const line = '姓名 | 年龄'
  assert.equal(cellSourceOffset(line, 0), 0)
  assert.equal(cellSourceOffset(line, 1), 5)
})

test('表格点击：转义竖线不切分', () => {
  const line = '| a\\|b | c |'
  assert.equal(cellSourceOffset(line, 0), 2)
  // 第二列在转义竖线之后
  assert.equal(cellSourceOffset(line, 1), line.indexOf('| c') + 2)
})

test('表格点击：列越界收敛到最后一列', () => {
  const line = '| a | b |'
  const last = cellSourceOffset(line, 1)
  assert.equal(cellSourceOffset(line, 99), last)
})

/* ---------------- needsScrollIntoView ---------------- */

test('光标跟随：视口外需要滚动', () => {
  const viewport = { top: 100, bottom: 500 }
  assert.equal(needsScrollIntoView({ top: 40, bottom: 60 }, viewport), true)
  assert.equal(needsScrollIntoView({ top: 540, bottom: 560 }, viewport), true)
})

test('光标跟随：视口内不需要滚动', () => {
  const viewport = { top: 100, bottom: 500 }
  assert.equal(needsScrollIntoView({ top: 200, bottom: 220 }, viewport), false)
})

test('光标跟随：坐标不可测时按需要滚动处理', () => {
  assert.equal(needsScrollIntoView(null, { top: 0, bottom: 100 }), true)
  assert.equal(needsScrollIntoView({ top: 10, bottom: 20 }, null), true)
})
