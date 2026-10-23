/**
 * markdown v2 —— 格式操作纯函数（CM keymap 与右键菜单共用一份实现）。
 */

/** 选区包裹 / 空选区插入成对标记并把光标放中间 */
export function wrapSelection(view, marker) {
  const tr = view.state.selection.main
  if (tr.empty) {
    view.dispatch({
      changes: { from: tr.from, insert: marker + marker },
      selection: { anchor: tr.from + marker.length },
    })
  } else {
    const sel = view.state.sliceDoc(tr.from, tr.to)
    // 已包裹则解除
    if (sel.startsWith(marker) && sel.endsWith(marker) && sel.length >= marker.length * 2) {
      view.dispatch({
        changes: { from: tr.from, to: tr.to, insert: sel.slice(marker.length, sel.length - marker.length) },
        selection: { anchor: tr.from, head: tr.from + sel.length - marker.length * 2 },
      })
    } else {
      view.dispatch({
        changes: { from: tr.from, to: tr.to, insert: `${marker}${sel}${marker}` },
        selection: { anchor: tr.from + marker.length, head: tr.to + marker.length },
      })
    }
  }
  view.focus()
  return true
}

/** 行前缀切换（标题/列表/引用…）；多选区行批量；已有前缀则移除 */
export function toggleLinePrefix(view, prefix) {
  const { state } = view
  const tr = state.selection.main
  const firstLine = state.doc.lineAt(tr.from).number
  const lastLine = state.doc.lineAt(tr.to).number
  const changes = []
  let allHas = true
  for (let n = firstLine; n <= lastLine; n++) {
    const line = state.doc.line(n)
    if (!line.text.startsWith(prefix)) allHas = false
  }
  for (let n = firstLine; n <= lastLine; n++) {
    const line = state.doc.line(n)
    if (allHas) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: '' })
    } else if (line.text.startsWith(prefix)) {
      continue
    } else {
      // 数字/任务前缀冲突时先剥同类标记（如从 - 换成 - [ ]）
      const alt = altPrefixOf(prefix, line.text)
      if (alt) changes.push({ from: line.from, to: line.from + alt.length, insert: prefix })
      else changes.push({ from: line.from, insert: prefix })
    }
  }
  view.dispatch({ changes })
  view.focus()
  return true
}

/** 已有同类标记要替换：任务/普通列表/引用互转、同级标题互转 */
function altPrefixOf(prefix, lineText) {
  if (prefix === '- [ ] ') { const m = /^[-*+] /.exec(lineText); return m ? m[0] : null }
  if (prefix === '- ' || prefix === '* ') { const m = /^[-*+] \[[ xX]\] /.exec(lineText); return m ? m[0] : null }
  if (/^#{1,6} $/.test(prefix)) { const m = /^#{1,6} /.exec(lineText); return m && m[0] !== prefix ? m[0] : null }
  return null
}

/** 插入块文本并把光标放到指定偏移 */
export function insertBlock(view, text, cursorOffset = 0) {
  const tr = view.state.selection.main
  const needNewline = tr.from > 0 && view.state.sliceDoc(tr.from - 1, tr.from) !== '\n'
  const insert = (needNewline ? '\n' : '') + text
  view.dispatch({
    changes: { from: tr.from, insert },
    selection: { anchor: tr.from + (needNewline ? 1 : 0) + cursorOffset },
  })
  view.focus()
  return true
}

export const FENCE_TEXT = '```\n\n```'
export const TABLE_TEXT = '| 列1 | 列2 |\n| --- | --- |\n|  |  |'
export const LINK_TEXT = '[](url)'
export const IMAGE_TEXT = '![](url)'
