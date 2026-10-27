/**
 * markdown —— 点击坐标 → 源码位置的纯函数（不依赖 CodeMirror 运行时）。
 *
 * 原子块（代码/表格/公式/HTML）渲染态是一整块 widget：CM 的 posAtCoords 只能
 * 给出块的起止位置，点块内任何位置都会跳到块首。要把「点到 java 后面」落到
 * 对应字符，需要把坐标换算成块内字符偏移，再收敛进 [from, to]。
 * 这里只放可单测的纯计算，DOM/CM 调用留在 live.js。
 */

/** 把任意文档位置收敛到 [from, to]；非法输入回落到块起点 */
export function clampToBlock(pos, from, to) {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const n = Number(pos)
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

/** 块内第 lineIndex 行的起始字符偏移（越界自动收敛到首/末行） */
export function offsetOfLine(blockText, lineIndex) {
  const text = String(blockText ?? '')
  if (!text) return 0
  const lines = text.split('\n')
  const raw = Math.trunc(Number(lineIndex))
  const idx = Math.min(Math.max(Number.isFinite(raw) ? raw : 0, 0), lines.length - 1)
  let offset = 0
  for (let i = 0; i < idx; i++) offset += lines[i].length + 1
  return offset
}

/**
 * 表格行内第 cellIndex 个单元格的内容起始列（源码字符偏移）。
 * 首尾竖线不参与计数；单元格内容跳过前导空白。
 */
export function cellSourceOffset(lineText, cellIndex) {
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
  // 去掉开头/结尾的空段（行首尾竖线造成）
  if (segments.length > 1 && line.slice(segments[0][0], segments[0][1]).trim() === '') segments.shift()
  if (segments.length > 1 && line.slice(segments[segments.length - 1][0], segments[segments.length - 1][1]).trim() === '') segments.pop()
  const seg = segments[Math.min(want, segments.length - 1)]
  if (!seg) return 0
  let offset = seg[0]
  while (offset < seg[1] && /\s/.test(line[offset])) offset++
  return offset
}

/** 代码块渲染态文本偏移 → 源码偏移（渲染态不含 ```lang 围栏行） */
export function codeSourceOffset(blockText, codeOffset) {
  const text = String(blockText ?? '')
  const firstLine = text.split('\n', 1)[0] ?? ''
  const base = firstLine.length + 1
  const off = Math.max(0, Math.trunc(Number(codeOffset)) || 0)
  return base + Math.min(off, Math.max(0, text.length - base))
}

/**
 * 是否需要把光标滚进可视区：光标在视口上下边缘之外（或坐标不可测）时为真。
 * 关闭打字机模式时，点击原子块后也要保证光标可见。
 */
export function needsScrollIntoView(caretRect, viewportRect, margin = 4) {
  if (!caretRect || !viewportRect) return true
  return caretRect.top < viewportRect.top + margin || caretRect.bottom > viewportRect.bottom - margin
}
