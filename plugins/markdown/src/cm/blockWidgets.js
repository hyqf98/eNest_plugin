import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import { render, renderTableCell } from '../render/render.js'
import { diagramLabelStart, fenceContentRange, htmlTextStart, mathContentStart } from './clickMap.js'
import { textOffsetAtPoint } from './domPoint.js'
import { currentTableText, tableSourceOffsetAt, updateTableDOM, wireTable } from './tableUI.js'
import { observeWidgetSize, selectWidgetSource, widgetEdgeCoords, widgetSourceRange } from './widgetSource.js'

const mounted = new WeakMap()
const revealOnPointer = new WeakMap()
const managedTargets = 'table.md-table, .md-table-col-handle, .md-image-widget, button, textarea, input, select'
const blockLabels = { fence: '代码或图表', math: '公式', html: 'HTML', table: '表格' }

function sameOptions(left, right) {
  return left.renderHtml === right.renderHtml && left.documentKey === right.documentKey && left.resolveImage === right.resolveImage &&
    left.onLinkClick === right.onLinkClick && left.diagramLook === right.diagramLook && left.dark === right.dark
}

function diagramPoint(body, target, x, y) {
  if (!target || ['g', 'rect', 'path', 'polygon', 'circle', 'ellipse'].includes(target.localName)) return 0
  const element = target.closest?.('tspan, text, .nodeLabel, .edgeLabel, .cluster-label')
  if (!element || !element.closest('.md-mermaid')) return 0
  const raw = element.textContent
  const label = raw.trim()
  const from = diagramLabelStart(body, label)
  if (from == null) return 0
  return from + Math.min(label.length, Math.max(0, (textOffsetAtPoint(element, x, y) ?? 0) - raw.indexOf(label)))
}

function htmlPoint(source, element, x, y) {
  let offset = textOffsetAtPoint(element, x, y)
  if (offset == null) return 0
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const text = walker.currentNode.data
    if (offset <= text.length) {
      const start = htmlTextStart(source, text)
      return start == null ? 0 : start + offset
    }
    offset -= text.length
  }
  return 0
}

function blockPoint(wrap, view, x, y, target) {
  const entry = mounted.get(wrap)
  if (!entry || entry.view !== view) return null
  const { blockType, blockText } = entry.widget
  const range = widgetSourceRange(view, wrap, blockText)
  if (!range) return null
  let offset = 0
  if (blockType === 'fence') {
    const fence = fenceContentRange(blockText)
    if (!fence) return null
    const code = wrap.querySelector('.cm-static-lines')
    const measured = code ? textOffsetAtPoint(code, x, y) ?? 0 : diagramPoint(blockText.slice(fence.from, fence.to), target, x, y)
    offset = Math.min(fence.to, fence.from + measured)
  } else if (blockType === 'math') {
    offset = mathContentStart(blockText)
  } else if (blockType === 'html') {
    const raw = wrap.querySelector('.md-html-raw')
    offset = raw ? textOffsetAtPoint(raw, x, y) ?? 0 : target?.closest?.('.md-html-block') ? htmlPoint(blockText, target, x, y) : 0
  } else if (blockType === 'table') {
    offset = tableSourceOffsetAt(wrap, target, x, y) ?? 0
  }
  return range.from + offset
}

function useSourcePointer(target, event) {
  return event.button === 0 && !target?.closest?.(managedTargets) &&
    !((event.metaKey || event.ctrlKey) && target?.closest?.('a[href]'))
}

function clickedRange(state, { pos, assoc }, count) {
  if (count === 2) return state.wordAt(pos) ?? EditorSelection.cursor(pos, assoc)
  if (count >= 3) {
    const line = state.doc.lineAt(pos)
    return EditorSelection.range(line.from, Math.min(state.doc.length, line.to + 1))
  }
  return EditorSelection.cursor(pos, assoc)
}

export const blockPointerSelection = [
  EditorView.mouseSelectionStyle.of((view, down) => {
    if (view.composing || !useSourcePointer(down.target, down)) return null
    const wrap = down.target.closest?.('.md-atomic')
    const point = { x: down.clientX, y: down.clientY }
    let origin
    if (wrap) {
      const pos = blockPoint(wrap, view, point.x, point.y, down.target)
      if (pos == null) return null
      origin = { pos, assoc: 1 }
    } else {
      if (view.dom.dataset.mdSource !== 'off' || down.detail !== 1 || down.metaKey || down.ctrlKey || down.altKey || !down.target.closest?.('.cm-line')) return null
      origin = view.posAndSideAtCoords(point, false)
    }
    let start = clickedRange(view.state, origin, down.detail)
    let original = view.state.selection
    return {
      update(update) {
        if (update.docChanged) { start = start.map(update.changes); original = original.map(update.changes) }
      },
      get(event, extend, multiple) {
        let range = start
        if (event !== down) {
          const coordinates = { x: event.clientX, y: event.clientY }
          const target = view.root.elementFromPoint(coordinates.x, coordinates.y)
          const pos = blockPoint(target?.closest('.md-atomic'), view, coordinates.x, coordinates.y, target)
          const hit = pos == null ? view.posAndSideAtCoords(coordinates, false) : { pos, assoc: 1 }
          const current = clickedRange(view.state, hit, down.detail)
          if (current.from < start.from) range = EditorSelection.range(start.to, current.from, undefined, undefined, current.assoc)
          else if (current.to > start.to) range = EditorSelection.range(start.from, current.to, undefined, undefined, current.assoc)
        }
        const selection = extend ? original.replaceRange(original.main.extend(range.from, range.to, range.assoc)) :
          multiple ? original.addRange(range) : EditorSelection.create([range])
        if (event === down && wrap) revealOnPointer.set(view.state, selection.main.head)
        return selection
      }
    }
  }),
  EditorState.transactionExtender.of(transaction => {
    const head = revealOnPointer.get(transaction.startState)
    if (head == null) return null
    revealOnPointer.delete(transaction.startState)
    if (transaction.isUserEvent('select.pointer') && transaction.selection?.main.head === head) {
      return { effects: EditorView.scrollIntoView(head, { y: 'nearest' }) }
    }
    return null
  })
]

export class AtomicBlockWidget extends WidgetType {
  constructor(blockText, blockType, opts = {}, key, enterSourceMode) {
    super()
    this.blockText = blockText
    this.blockType = blockType
    this.opts = opts
    this.key = key
    this.enterSourceMode = enterSourceMode
  }

  eq(other) {
    return other.key === this.key && other.blockType === this.blockType && other.blockText === this.blockText && sameOptions(other.opts, this.opts)
  }

  updateDOM(wrap, view) {
    const entry = mounted.get(wrap)
    if (this.blockType !== 'table' || entry?.view !== view || entry.widget.key !== this.key || entry.widget.blockType !== 'table' || !sameOptions(entry.widget.opts, this.opts)) return false
    if (!updateTableDOM(wrap, currentTableText(wrap), this.blockText)) return false
    entry.widget = this
    return true
  }

  toDOM(view) {
    const wrap = view.contentDOM.ownerDocument.createElement('div')
    wrap.className = `md-atomic md-atomic-${this.blockType}`
    wrap.setAttribute('role', 'group')
    wrap.setAttribute('aria-label', `${blockLabels[this.blockType]}，可编辑`)
    if (this.blockType !== 'table') wrap.tabIndex = 0
    const controller = new AbortController()
    const options = { ...this.opts, mode: this.blockType, signal: controller.signal }
    const entry = { view, widget: this, controller, table: null, resize: observeWidgetSize(view, wrap) }
    mounted.set(wrap, entry)
    wrap.appendChild(render(this.blockText, options).dom)
    const text = () => currentTableText(wrap) ?? entry.widget.blockText
    const getFrom = (expected = text()) => widgetSourceRange(view, wrap, expected)?.from ?? null
    const requestSource = position => {
      const from = getFrom()
      return from != null && selectWidgetSource(view, wrap, text(), position - from)
    }
    if (this.blockType === 'table') {
      entry.table = wireTable(wrap, view, getFrom, this.blockText, { renderCell: value => renderTableCell(value, options), renderHtml: options.renderHtml, requestSource, requestSourceMode: () => this.enterSourceMode(view) })
      if (!entry.table) wrap.tabIndex = 0
    }
    wrap.addEventListener('click', event => {
      const link = event.target.closest?.('a[href]')
      if (link) {
        event.preventDefault()
        if (event.metaKey || event.ctrlKey) {
          event.stopPropagation()
          if (getFrom() != null) entry.widget.opts.onLinkClick?.(link.getAttribute('href'))
          return
        }
      }
      if (!useSourcePointer(event.target, event)) return
      const position = blockPoint(wrap, view, event.clientX, event.clientY, event.target)
      if (position != null) requestSource(position)
    }, { signal: controller.signal })
    wrap.addEventListener('keydown', event => {
      if (event.target !== wrap || !['Enter', 'F2'].includes(event.key)) return
      const from = getFrom()
      if (from == null) return
      event.preventDefault()
      requestSource(from)
    }, { signal: controller.signal })
    return wrap
  }

  ignoreEvent(event) { return event.type !== 'mousedown' || !useSourcePointer(event.target, event) }

  coordsAt(dom, pos) { return widgetEdgeCoords(dom, pos > 0, true) }

  destroy(dom) {
    const entry = mounted.get(dom)
    if (!entry) return
    entry.controller.abort()
    entry.table?.()
    entry.resize()
    mounted.delete(dom)
  }
}
