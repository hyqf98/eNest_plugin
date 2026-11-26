import { EditorSelection } from '@codemirror/state'

export const FENCE_TEXT = '```\n\n```'
export const TABLE_TEXT = '| 列1 | 列2 |\n| --- | --- |\n|  |  |'
export const LINK_TEXT = '[](url)'
export const IMAGE_TEXT = '![](url)'

function dispatchFormat(view, spec) {
  view.dispatch(spec, { scrollIntoView: true, userEvent: 'input.format' })
  view.focus()
  return true
}

function maintainDirection(range, first, last) {
  return range.head < range.anchor ? EditorSelection.range(last, first) : EditorSelection.range(first, last)
}

export function wrapSelection(view, marker) {
  const { state } = view
  return dispatchFormat(view, state.changeByRange(range => {
    const { from, to } = range
    const text = state.sliceDoc(from, to)
    const width = marker.length
    if (from >= width && state.sliceDoc(from - width, from) === marker && state.sliceDoc(to, to + width) === marker) {
      return { changes: [{ from: from - width, to: from }, { from: to, to: to + width }], range: maintainDirection(range, from - width, to - width) }
    }
    if (text.length >= width * 2 && text.startsWith(marker) && text.endsWith(marker)) {
      return { changes: { from, to, insert: text.slice(width, -width) }, range: maintainDirection(range, from, to - 2 * width) }
    }
    return { changes: { from, to, insert: marker + text + marker }, range: maintainDirection(range, from + width, to + width) }
  }))
}

export function toggleLinePrefix(view, prefix) {
  const { state } = view
  const rows = new Set()
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.empty ? range.to : range.to - 1).number
    for (let number = state.doc.lineAt(range.from).number; number <= last; number++) rows.add(number)
  }
  const matcher = prefix.startsWith('#') ? /^#{1,6}[ \t]+/ : prefix === '> ' ? /^>[ \t]?/ : /^(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/
  const lines = [...rows].sort((left, right) => left - right).map(number => {
    const line = state.doc.line(number)
    const indent = /^[ \t]*/.exec(line.text)[0].length
    return { from: line.from + indent, existing: matcher.exec(line.text.slice(indent))?.[0] || '' }
  })
  const matches = marker => prefix === '- [ ] ' ? /^[-+*]\s+\[[ xX]\]\s+$/.test(marker) : prefix === '1. ' ? /^\d{1,9}[.)]\s+$/.test(marker) : marker === prefix
  const remove = lines.every(line => matches(line.existing))
  const changes = state.changes(lines.flatMap(({ from, existing }) => !remove && matches(existing) ? [] : [{ from, to: from + existing.length, insert: remove ? '' : prefix }]))
  return dispatchFormat(view, { changes, selection: state.selection.map(changes, 1) })
}

export function insertBlock(view, template, cursorOffset = 0) {
  const { state } = view
  return dispatchFormat(view, state.changeByRange(range => {
    const { from, to } = range
    const text = state.sliceDoc(from, to)
    if (template === LINK_TEXT || template === IMAGE_TEXT) {
      const label = text.replace(/[[\]\\]/g, '\\$&')
      const prefix = template === IMAGE_TEXT ? '![' : '['
      const insert = `${prefix}${label}](url)`
      const start = from + prefix.length + (text ? label.length + 2 : 0)
      return { changes: { from, to, insert }, range: EditorSelection.range(start, start + (text ? 3 : 0)) }
    }
    const before = from > state.doc.lineAt(from).from ? '\n' : ''
    const after = to < state.doc.lineAt(to).to ? '\n' : ''
    const block = template === FENCE_TEXT && text ? '```\n' + text + '\n```' : template
    const start = from + before.length + cursorOffset
    return { changes: { from, to, insert: before + block + after }, range: EditorSelection.range(start, start + (template === FENCE_TEXT ? text.length : 0)) }
  }))
}
