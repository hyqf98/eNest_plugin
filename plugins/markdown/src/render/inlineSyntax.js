export function inlineMarkupEnd(text, start, marker, limit = text.length) {
  if (!text.startsWith(marker, start) || text[start - 1] === marker[0] || text[start + marker.length] === marker[0]) return -1
  const content = start + marker.length
  if (content >= limit || /\s/.test(text[content])) return -1
  for (let position = content; position < limit; position++) {
    const character = text[position]
    if (character === '\n' || character === '\r') return -1
    if (character === '\\' && text[position + 1] !== '\n' && text[position + 1] !== '\r') { position++; continue }
    if (marker === '==' && character === '`') {
      let end = position + 1
      while (end < limit && text[end] === '`') end++
      const width = end - position
      position = end - 1
      for (let cursor = end; cursor < limit && text[cursor] !== '\n' && text[cursor] !== '\r'; cursor++) {
        if (text[cursor] !== '`') continue
        let after = cursor + 1
        while (after < limit && text[after] === '`') after++
        if (after - cursor === width) { position = after - 1; break }
        cursor = after - 1
      }
      continue
    }
    if (!text.startsWith(marker, position) || position + marker.length > limit) continue
    if (position === content || /\s/.test(text[position - 1]) || text[position + marker.length] === marker[0]) return -1
    if (marker === '$' && /[0-9]/.test(text[position + 1] || '')) return -1
    return position + marker.length
  }
  return -1
}

const inlineRules = [{ name: 'MarkedText', marker: '==' }, { name: 'InlineFormula', marker: '$' }]
export const inlineMarkdownSyntax = {
  defineNodes: ['MarkedText', 'HighlightMark', 'InlineFormula'],
  parseInline: inlineRules.map(({ name, marker }) => ({
    name, after: 'InlineCode',
    parse(context, next, position) {
      if (next !== marker.charCodeAt(0)) return -1
      const relative = inlineMarkupEnd(context.text, position - context.offset, marker)
      if (relative < 0) return -1
      const end = relative + context.offset
      const children = marker === '==' ? [
        context.elt('HighlightMark', position, position + 2),
        ...context.parser.parseInline(context.slice(position + 2, end - 2), position + 2),
        context.elt('HighlightMark', end - 2, end),
      ] : []
      return context.addElement(context.elt(name, position, end, children))
    },
  })),
}

export function renderTaskLists(markdown) {
  const marker = /^\[([ xX])\][ \t]+/
  markdown.core.ruler.before('inline', 'task_list', state => {
    for (let index = 2; index < state.tokens.length; index++) {
      const inline = state.tokens[index], item = state.tokens[index - 2]
      if (inline.type !== 'inline' || state.tokens[index - 1].type !== 'paragraph_open' || item.type !== 'list_item_open') continue
      const prefix = marker.exec(inline.content)
      if (!prefix) continue
      const box = new state.Token('html_inline', '', 0)
      box.content = prefix[1].toLowerCase() === 'x'
        ? '<input type="checkbox" class="task-list-item-checkbox" disabled checked> '
        : '<input type="checkbox" class="task-list-item-checkbox" disabled> '
      inline.content = inline.content.slice(prefix[0].length)
      inline.children.push(box)
      item.attrJoin('class', 'task-list-item md-task-list-item')
    }
  })
}
