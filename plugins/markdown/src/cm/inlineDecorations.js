import { syntaxTree } from '@codemirror/language'
import { StateField } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import { InlineImage, InlineMath, ListBullet, TaskCheckbox } from './inlineWidgets.js'

export { getImageSourceRange } from './inlineWidgets.js'
export { inlineMarkdownSyntax } from '../render/inlineSyntax.js'

const literalBlocks = new Set(['fence', 'table', 'math', 'html', 'meta'])
const literalNodes = new Set(['FencedCode', 'CodeBlock', 'Table', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock'])
const styles = new Map([
  ['StrongEmphasis', 'md-strong'], ['Emphasis', 'md-em'], ['Strikethrough', 'md-strike'],
  ['InlineCode', 'md-code'], ['MarkedText', 'md-highlight'],
])
const hidden = Decoration.replace({})
const syntaxMark = Decoration.mark({ class: 'md-syntax-marker' })
const quietQuote = Decoration.mark({ class: 'md-quote-prefix' })
const bullet = Decoration.replace({ widget: new ListBullet() })
const dimensionTail = /^\{\s*((?:(?:width|height|align)\s*=\s*[^}\s]+\s*)+)\}/i

function rangeTouches(range, from, to, includeEnd) {
  return range.from === range.to
    ? range.from >= from && (includeEnd ? range.from <= to : range.from < to)
    : range.from < to && range.to > from
}

export function selectionTouches(ranges, from, to, includeEnd = true) {
  return ranges.some(range => rangeTouches(range, from, to, includeEnd))
}

function editingRanges(state, config) {
  return config.editing ? state.selection.ranges : []
}

function literalNode(node, blocks) {
  if (literalNodes.has(node.name)) return true
  if (node.name === 'Document') return false
  let low = 0, high = blocks.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (blocks[middle].from <= node.from) low = middle + 1
    else high = middle
  }
  const block = blocks[low - 1]
  return block && literalBlocks.has(block.type) && node.to <= block.to
}

function read(doc, node) { return doc.sliceString(node.from, node.to) }
function labelKey(value) { return value.trim().replace(/\s+/g, ' ').toLowerCase() }
function linkTarget(value) {
  return value.replace(/^<([\s\S]*)>$/, '$1').replace(/\\([!-/:-@\[-`{-~])/g, '$1')
}

function linkParts(doc, node, references) {
  const [open, close, destination] = node.getChildren('LinkMark')
  if (!open || !close) return null
  const label = doc.sliceString(open.to, close.from)
  const urlNode = node.getChild('URL')
  let url
  if (urlNode || destination) url = urlNode ? linkTarget(read(doc, urlNode)) : ''
  else {
    const reference = node.getChild('LinkLabel')
    url = references.get(labelKey(reference && reference.to - reference.from > 2 ? read(doc, reference).slice(1, -1) : label))
    if (url === undefined) return null
  }
  return { label, url, from: open.to, to: close.from }
}

function imageSpec(doc, node, references) {
  const parts = linkParts(doc, node, references)
  if (!parts?.url || doc.lineAt(node.from).number !== doc.lineAt(node.to).number) return null
  const line = doc.lineAt(node.to)
  const match = dimensionTail.exec(doc.sliceString(node.to, line.to))
  const end = node.to + (match?.[0].length || 0)
  const attrs = {}
  for (const pair of (match?.[1] || '').matchAll(/(width|height|align)\s*=\s*([^}\s]+)/gi)) {
    const key = pair[1].toLowerCase(), value = pair[2].replace(/^["']|["']$/g, '')
    if (key === 'align' ? /^(left|center|right)$/i.test(value) : /^\d+(?:\.\d+)?(?:px|%)?$/.test(value)) {
      attrs[key] = /^\d+(?:\.\d+)?$/.test(value) ? `${value}px` : value.toLowerCase()
    }
  }
  return {
    from: node.from, to: end, imageLength: node.to - node.from, source: doc.sliceString(node.from, end),
    image: { url: parts.url, alt: parts.label, attrs, standalone: !doc.sliceString(line.from, node.from).trim() && !doc.sliceString(end, line.to).trim() },
  }
}

function indexInlineMedia(state, blocks) {
  const doc = state.doc, references = new Map(), nodes = []
  syntaxTree(state).iterate({
    enter(ref) {
      if (literalNode(ref, blocks)) return false
      if (ref.name === 'LinkReference') {
        const label = ref.node.getChild('LinkLabel'), url = ref.node.getChild('URL')
        if (label && url) {
          const key = labelKey(read(doc, label).slice(1, -1))
          if (!references.has(key)) references.set(key, linkTarget(read(doc, url)))
        }
        return false
      }
      if (ref.name === 'Image' || ref.name === 'InlineFormula') { nodes.push(ref.node); return false }
      if (ref.name === 'InlineCode') return false
    },
  })
  const media = []
  for (const node of nodes) {
    const item = node.name === 'Image' ? imageSpec(doc, node, references) : { from: node.from, to: node.to, source: read(doc, node) }
    if (item) media.push(item)
  }
  return { references, media }
}

const emptyMediaState = { index: { media: [], references: new Map() }, decorations: Decoration.none }

function mediaState(state, config, index, previous) {
  const exposed = new Set(), media = index.media, resolveImage = config.opts?.resolveImage
  for (const range of editingRanges(state, config)) {
    let low = 0, high = media.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (media[middle].to < range.from) low = middle + 1
      else high = middle
    }
    for (let cursor = low; cursor < media.length && media[cursor].from <= range.to; cursor++) {
      if (rangeTouches(range, media[cursor].from, media[cursor].to, true)) exposed.add(cursor)
    }
  }
  if (previous?.index === index && previous.resolveImage === resolveImage && previous.exposed.size === exposed.size && [...exposed].every(key => previous.exposed.has(key))) return previous
  const decorations = []
  for (let cursor = 0; cursor < media.length; cursor++) {
    if (exposed.has(cursor)) continue
    const item = media[cursor]
    const widget = item.image ? new InlineImage(item.source, item.imageLength, item.image, resolveImage) : new InlineMath(item.source)
    decorations.push(Decoration.replace({ widget }).range(item.from, item.to))
  }
  return { index, resolveImage, exposed, decorations: Decoration.set(decorations, true) }
}

function makeMediaField(liveField) {
  const make = state => {
    const { config, blocks } = state.field(liveField)
    return config.enabled ? mediaState(state, config, indexInlineMedia(state, blocks)) : emptyMediaState
  }
  return StateField.define({
    create: make,
    update(previous, transaction) {
      const state = transaction.state, start = transaction.startState
      const live = state.field(liveField), old = start.field(liveField)
      if (!live.config.enabled) return emptyMediaState
      if (live.config.composing && old.config.enabled) {
        return transaction.docChanged ? { ...previous, decorations: previous.decorations.map(transaction.changes) } : previous
      }
      if (!old.config.enabled || transaction.docChanged || old.config.composing || syntaxTree(start) !== syntaxTree(state) || old.blocks !== live.blocks) return make(state)
      if (!transaction.selection && old.config === live.config) return previous
      return mediaState(state, live.config, previous.index, previous)
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  })
}

export function inlineMarkDecorations(state, visibleRanges, { config, blocks }, references) {
  if (!config.enabled) return Decoration.none
  const { doc } = state
  const selections = editingRanges(state, config), ranges = [], seen = new Set()
  const add = (decoration, from, to) => { if (from < to) ranges.push(decoration.range(from, to)) }
  const delimit = (from, to, reveal) => {
    if (reveal) { add(syntaxMark, from, to); return }
    while (from < to) {
      const end = Math.min(doc.lineAt(from).to, to)
      add(hidden, from, end)
      from = end + 1
    }
  }
  const link = (from, to, url) => add(Decoration.mark({ class: 'md-link', attributes: { 'data-md-link-target': url } }), from, to)
  function enter(ref) {
    const { name, from, to } = ref
    if (literalNode(ref, blocks) || name === 'LinkReference' || name === 'Image' || name === 'InlineFormula' || from === to) return false
    if (visibleRanges.length > 1 && (styles.has(name) || ['Link', 'Autolink', 'URL', 'HeaderMark', 'ListMark', 'TaskMarker', 'QuoteMark', 'Escape'].includes(name))) {
      const key = `${from}:${to}:${name}`
      if (seen.has(key)) return
      seen.add(key)
    }
    const active = selectionTouches(selections, from, to)
    if (styles.has(name)) {
      const node = ref.node, first = node.firstChild, last = node.lastChild
      if (first && last && first !== last && first.to <= last.from) {
        delimit(first.from, first.to, active)
        delimit(last.from, last.to, active)
        add(Decoration.mark({ class: styles.get(name) }), first.to, last.from)
      }
      if (name === 'InlineCode') return false
    } else if (name === 'Link') {
      const parts = linkParts(doc, ref.node, references)
      if (!parts) return
      delimit(from, parts.from, active)
      delimit(parts.to, to, active)
      link(parts.from, parts.to, parts.url)
    } else if (name === 'Autolink' || name === 'URL') {
      if (name === 'URL' && ref.node.parent?.name === 'Link') return false
      const url = ref.node.getChild('URL') || ref.node
      const value = read(doc, url)
      link(url.from, url.to, /^www\./i.test(value) ? `https://${value}` : value)
      delimit(from, url.from, active)
      delimit(url.to, to, active)
      return false
    } else if (name === 'HeaderMark') {
      if (ref.node.parent?.name.startsWith('SetextHeading')) return
      const next = /^[ \t]/.test(doc.sliceString(to, to + 1)) ? to + 1 : to
      delimit(from, next, selectionTouches(selections, from, next, false))
    } else if (name === 'QuoteMark') {
      add(active ? syntaxMark : quietQuote, from, to)
    } else if (name === 'ListMark') {
      if (!/^[-*+]$/.test(read(doc, ref))) return
      const task = ref.node.parent?.getChild('Task')?.getChild('TaskMarker')
      if (task && !selectionTouches(selections, from, task.to)) delimit(from, task.from, false)
      else if (active || task) add(syntaxMark, from, to)
      else add(bullet, from, to)
    } else if (name === 'TaskMarker') {
      const marker = ref.node.parent?.parent?.getChild('ListMark')
      if (selectionTouches(selections, marker?.from ?? from, to)) add(syntaxMark, from, to)
      else add(Decoration.replace({ widget: new TaskCheckbox(read(doc, ref), state.readOnly) }), from, to)
    } else if (name === 'Escape') {
      delimit(from, from + 1, active)
    }
  }
  for (const visible of visibleRanges) syntaxTree(state).iterate({ ...visible, enter })
  return Decoration.set(ranges, true)
}

export function createInlinePlugin(liveField) {
  const media = makeMediaField(liveField)
  const forView = ({ state, visibleRanges }) => inlineMarkDecorations(state, visibleRanges, state.field(liveField), state.field(media).index.references)
  const marks = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = forView(view) }
    update(update) {
      const current = update.state.field(liveField), previous = update.startState.field(liveField)
      if (current.config.composing && current.config.enabled) {
        this.decorations = this.decorations.map(update.changes)
      } else if (update.docChanged || update.selectionSet || update.viewportChanged || current.config !== previous.config || update.state.readOnly !== update.startState.readOnly || syntaxTree(update.state) !== syntaxTree(update.startState)) {
        this.decorations = forView(update.view)
      }
    }
  }, { decorations: value => value.decorations })
  return [media, marks, EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false
      const link = event.target.closest?.('[data-md-link-target]')
      const open = view.state.field(liveField).config.opts?.onLinkClick
      if (!link || !open || !view.contentDOM.contains(link)) return false
      event.preventDefault()
      open(link.dataset.mdLinkTarget)
      return true
    },
  })]
}
