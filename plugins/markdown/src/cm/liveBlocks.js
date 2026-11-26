import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { firstBlockAtOrAfter, parseBlocks } from './blocks.js'
import { AtomicBlockWidget } from './blockWidgets.js'
import { tableSelection } from './tableUI.js'

export const setLiveEnabled = StateEffect.define()
export const setLiveOpts = StateEffect.define()
export const setComposing = StateEffect.define()
export const setEditorFocus = StateEffect.define()

const previewTypes = new Set(['table', 'fence', 'math', 'html'])
const lineStyles = { quote: 'md-quote', list: 'md-list', meta: 'md-meta', hr: 'md-hrline' }
const rulePreview = Decoration.replace({ widget: new class extends WidgetType {
  toDOM(view) {
    const rule = view.dom.ownerDocument.createElement('span')
    rule.className = 'md-rule-preview'
    rule.setAttribute('role', 'separator')
    return rule
  }
  ignoreEvent() { return false }
}() })

function identifyBlocks(doc, previous = [], changes) {
  const blocks = parseBlocks(doc.toString())
  const carried = new Map()
  for (const block of previous) {
    if (block.type !== 'table') continue
    const end = changes.mapPos(block.to, -1)
    const after = changes.mapPos(block.from, 1)
    if (end <= after) continue
    const mapped = { key: block.key, end }
    carried.set(after, mapped)
    carried.set(changes.mapPos(block.from, -1), mapped)
  }
  const used = new Set()
  for (const block of blocks) {
    if (block.type !== 'table') continue
    const prior = carried.get(block.from)
    block.key = prior && prior.end <= block.to && !used.has(prior.key) ? prior.key : Symbol('table')
    used.add(block.key)
  }
  return blocks
}

export function editableBlockStarts(blocks, selection) {
  const starts = new Set()
  for (const range of selection.ranges) {
    for (let index = firstBlockAtOrAfter(blocks, range.from); index < blocks.length && blocks[index].from <= range.to; index++) {
      const block = blocks[index]
      if (previewTypes.has(block.type) || block.type === 'hr' || block.style === 'setext') starts.add(block.from)
    }
  }
  return starts
}

function blockDecorations(doc, blocks, expanded, config) {
  if (!config.enabled) return Decoration.none
  const ranges = []
  for (const block of blocks) {
    const preview = previewTypes.has(block.type)
    const editing = expanded.has(block.from)
    if (preview && !editing && !block.incomplete) {
      const widget = new AtomicBlockWidget(block.text, block.type, config.opts, block.key, enterSourceMode)
      ranges.push(Decoration.replace({ widget, block: true }).range(block.from, block.to))
      continue
    }
    const first = doc.lineAt(block.from).number
    const last = doc.lineAt(block.to).number
    const style = preview ? `md-${block.type}-src` : block.type === 'heading' ? `md-h${block.level}` : lineStyles[block.type] || 'md-p'
    if (block.type === 'hr' && !editing) ranges.push(rulePreview.range(block.from, block.to))
    for (let number = first; number <= last; number++) {
      if (block.style === 'setext' && number === last) {
        if (!editing) ranges.push(Decoration.replace({}).range(doc.line(last - 1).to, block.to))
        else ranges.push(Decoration.line({ class: 'md-line md-syntax-marker' }).range(doc.line(last).from))
        continue
      }
      const edge = preview ? `${number === first ? ' md-source-start' : ''}${number === last ? ' md-source-end' : ''}` : ''
      ranges.push(Decoration.line({ class: `md-line ${style}${edge}` }).range(doc.line(number).from))
    }
  }
  return Decoration.set(ranges, true)
}

export function initialLiveState(state, opts = {}, enabled = true, editing = false) {
  const config = { opts, enabled, editing, composing: false }
  const blocks = identifyBlocks(state.doc)
  const expanded = editing ? editableBlockStarts(blocks, state.selection) : new Set()
  return { config, blocks, expanded, decorations: blockDecorations(state.doc, blocks, expanded, config) }
}

export const liveField = StateField.define({
  create: state => initialLiveState(state),
  update(previous, transaction) {
    let config = previous.config
    const inCell = transaction.annotation(tableSelection)
    if (inCell && config.editing) config = { ...config, editing: false }
    if (!inCell && transaction.selection && !config.editing && !transaction.isUserEvent('undo') && !transaction.isUserEvent('redo')) config = { ...config, editing: true }
    for (const effect of transaction.effects) {
      if (effect.is(setLiveEnabled) && config.enabled !== effect.value) config = { ...config, enabled: effect.value }
      if (effect.is(setLiveOpts) && config.opts !== effect.value) config = { ...config, opts: effect.value }
      if (effect.is(setComposing) && config.composing !== effect.value) config = { ...config, composing: effect.value }
      if (effect.is(setEditorFocus) && config.editing !== effect.value) config = { ...config, editing: effect.value }
    }
    if (!transaction.docChanged && !transaction.selection && config === previous.config) return previous
    const doc = transaction.newDoc
    const blocks = transaction.docChanged ? identifyBlocks(doc, previous.blocks, transaction.changes) : previous.blocks
    const expanded = config.editing ? editableBlockStarts(blocks, transaction.newSelection) : new Set()
    if (config.composing && previous.config.enabled === config.enabled) {
      return { config, blocks, expanded, decorations: previous.decorations.map(transaction.changes) }
    }
    if (blocks === previous.blocks && config === previous.config && expanded.size === previous.expanded.size && [...expanded].every(start => previous.expanded.has(start))) return previous
    return { config, blocks, expanded, decorations: blockDecorations(doc, blocks, expanded, config) }
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
})

function enterSourceMode(view) {
  if (toggleLive(view, false)) view.focus()
}

export function toggleLive(view, enabled = !view.state.field(liveField).config.enabled) {
  if (view.compositionStarted || view.state.field(liveField).config.composing) return false
  view.dispatch({ effects: [setLiveEnabled.of(enabled), EditorView.scrollIntoView(view.state.selection.main, { y: 'nearest' })] })
  return true
}
