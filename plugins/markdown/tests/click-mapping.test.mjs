import test from 'node:test'
import assert from 'node:assert/strict'

/* 复刻 src/cm/live.js 里的实现（依赖 CM 运行时的部分不在此验证） */
const LINE_PREFIX = /^\s{0,3}(?:#{1,6}\s+|>\s?|(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)/
function visibleOffsetToSource(lineText, target) {
  let i = 0
  const head = LINE_PREFIX.exec(lineText)
  if (head) i = head[0].length
  if (target <= 0) return i
  let visible = 0
  const n = lineText.length
  while (i < n) {
    const link = /^!?\[([^\]]+)\]\([^)]*\)/.exec(lineText.slice(i))
    if (link) {
      const label = link[1]
      const labelStart = i + link[0].indexOf('[') + 1
      if (target < visible + label.length) return labelStart + (target - visible)
      visible += label.length
      i += link[0].length
      continue
    }
    const pair = /^(\*\*|__|~~|==|`)/.exec(lineText.slice(i))
    if (pair) { i += pair[0].length; continue }
    if (visible === target) return i
    visible++
    i++
  }
  return n
}

const at = (line, target) => line.slice(visibleOffsetToSource(line, target))

test('点击映射：标题跳过 # 前缀', () => {
  assert.equal(at('## 标题文字', 0), '标题文字')
  // 可见文本「标题文字」，t=2 → 第 3 个可见字符处（"文"）
  assert.equal(at('## 标题文字', 2), '文字')
})

test('点击映射：加粗标记不计入可见字符', () => {
  assert.equal(at('这是**加粗**文本', 0), '这是**加粗**文本')
  // 可见「这是加粗文本」，t=2 → "加"
  assert.equal(at('这是**加粗**文本', 2), '加粗**文本')
})

test('点击映射：链接只把 label 计为可见', () => {
  const line = '看这个[链接文字](https://example.com)吧'
  // 可见「看这个链接文字吧」（8 字符）
  assert.equal(at(line, 3), '链接文字](https://example.com)吧')
  // t=7 → label 之后的那一个字（"吧"）
  assert.equal(at(line, 7), '吧')
})

test('点击映射：列表标记与任务框跳过', () => {
  assert.equal(at('- 项目', 0), '项目')
  assert.equal(at('- [ ] 待办', 0), '待办')
  assert.equal(at('- [ ] 待办', 1), '办')
  assert.equal(at('1. 第一项', 0), '第一项')
})

test('点击映射：行内代码标记跳过', () => {
  assert.equal(at('用 `code` 表示', 2), 'code` 表示')
})

test('点击映射：target 超出长度时落到行尾', () => {
  assert.equal(at('**短**', 999), '')
})
