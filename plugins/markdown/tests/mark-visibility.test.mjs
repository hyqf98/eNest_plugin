import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * 验证「光标碰到标记才显形」的判定语义（与 src/cm/live.js 的 touched 一致）。
 * touched = sel.from <= to + 1 && sel.to >= from - 1
 */
function touched(sel, from, to) {
  return sel.from <= to + 1 && sel.to >= from - 1
}

test('光标在标记外 → 标记隐藏', () => {
  // 标记是 ## (0-2)，光标在第 5 个字符
  assert.equal(touched({ from: 5, to: 5 }, 0, 2), false)
})

test('光标紧贴标记右边界 → 标记显形', () => {
  // 标记 ## 后紧跟空格，光标落在第 3 位（空格处）
  assert.equal(touched({ from: 3, to: 3 }, 0, 2), true)
})

test('光标在标记内部 → 显形', () => {
  assert.equal(touched({ from: 1, to: 1 }, 0, 2), true)
})

test('光标在标记左边界前一字符 → 显形（便于直接删）', () => {
  // 标记从 2 开始，光标在 1
  assert.equal(touched({ from: 1, to: 1 }, 2, 4), true)
})

test('光标远离两字符以上 → 隐藏', () => {
  assert.equal(touched({ from: 0, to: 0 }, 3, 5), false)
})

test('选区跨越标记 → 显形', () => {
  assert.equal(touched({ from: 0, to: 10 }, 2, 4), true)
})

test('行内元素样式：光标在元素内 → 不套样式（纯文本可编辑）', () => {
  // 与 live.js 中 `if (touched) return undefined` 对应
  const insideEmphasis = touched({ from: 4, to: 4 }, 2, 8)
  assert.equal(insideEmphasis, true) // → 不套 md-strong，显示 **粗体** 原文
})

test('行内元素样式：光标离开 → 套样式且标记隐藏', () => {
  const outside = touched({ from: 20, to: 20 }, 2, 8)
  assert.equal(outside, false) // → 套 md-strong + 隐藏 ** 
})
