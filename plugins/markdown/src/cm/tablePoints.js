import { markdownLanguage } from '@codemirror/lang-markdown'
import { inlineMarkdownSyntax } from '../render/inlineSyntax.js'

const parser = markdownLanguage.parser.configure(inlineMarkdownSyntax)
const markers = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark', 'HighlightMark'])
const htmlNodes = new Set(['HTMLTag', 'Comment', 'ProcessingInstruction'])
const imageSize = /^\{\s*(?:(?:width|height|align)\s*=\s*[^}\s]+\s*)+\}/i

export function cellTextOffset(source, rendered, caret, { decodeEntity, renderHtml, formulae = [], assoc = 1 } = {}) {
  const target = Math.max(0, Math.min(rendered.length, caret ?? 0))
  if (source === rendered) return target
  const prefix = 'x '
  const tree = parser.parse(prefix + source)
  const pieces = []
  let formulaIndex = 0
  const skip = (from, to, text = '') => pieces.push({ from: from - prefix.length, to: to - prefix.length, text })
  tree.iterate({ enter(node) {
    const { name, from, to } = node
    if (from < prefix.length) return
    if (name === 'Link' || name === 'Image') {
      const [open, close, destination] = node.node.getChildren('LinkMark')
      if (destination) {
        if (name === 'Image') {
          const suffix = imageSize.exec(source.slice(to - prefix.length))
          skip(from, to + (suffix?.[0].length || 0))
          return false
        }
        skip(open.from, open.to)
        skip(close.from, to)
      }
    }
    if (name === 'InlineCode') {
      const [open, close] = node.node.getChildren('CodeMark')
      const body = source.slice(open.to - prefix.length, close.from - prefix.length)
      if (body.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body)) {
        skip(open.to, open.to + 1)
        skip(close.from - 1, close.from)
      }
    }
    if (name === 'InlineFormula') {
      const renderedMath = formulae[formulaIndex++]
      skip(from, from + 1)
      skip(to - 1, to)
      if (renderedMath != null && renderedMath !== source.slice(from + 1 - prefix.length, to - 1 - prefix.length)) skip(from + 1, to - 1, renderedMath)
      return false
    }
    if (markers.has(name) || renderHtml !== false && htmlNodes.has(name) || name === 'LinkMark' && node.node.parent?.name === 'Autolink') { skip(from, to); return false }
    if (name === 'Escape') { skip(from, from + 1); return false }
    if (name === 'Entity' && decodeEntity) {
      const raw = source.slice(from - prefix.length, to - prefix.length)
      skip(from, to, decodeEntity(raw))
      return false
    }
    return undefined
  } })
  pieces.sort((left, right) => left.from - right.from || right.to - left.to)
  let projection = ''
  const starts = [], ends = []
  const append = (text, from, to, literal) => {
    projection += text
    for (let index = 0; index < text.length; index++) {
      starts.push(literal ? from + index : from)
      ends.push(literal ? from + index + 1 : to)
    }
  }
  let position = 0
  for (const piece of pieces) {
    if (piece.from < position) continue
    append(source.slice(position, piece.from), position, piece.from, true)
    append(piece.text, piece.from, piece.to, false)
    position = piece.to
  }
  append(source.slice(position), position, source.length, true)
  if (!projection.length) return 0
  const at = index => assoc < 0 && index > 0 ? ends[index - 1] : starts[index] ?? ends.at(-1) ?? 0
  if (projection === rendered) return at(target)
  let left = 0
  while (left < rendered.length && left < projection.length && projection[left] === rendered[left]) left++
  if (target <= left) return at(target)
  let tail = 0
  while (tail < rendered.length - left && tail < projection.length - left && rendered.at(-1 - tail) === projection.at(-1 - tail)) tail++
  if (target >= rendered.length - tail) return at(projection.length - rendered.length + target)
  return target - left <= rendered.length - tail - target ? at(left) : at(projection.length - tail)
}
