import { isolateHistory, redo, undo } from '@codemirror/commands'
import { Annotation, EditorState, Transaction, findClusterBreak } from '@codemirror/state'
import { Direction } from '@codemirror/view'
import { textPositionAtPoint } from './domPoint.js'
import { cellTextOffset } from './tablePoints.js'
import { IMAGE_TEXT, LINK_TEXT, insertBlock, wrapSelection } from './formatOps.js'
import { changedText } from '../js/textChange.js'
import {
  cellInputValue, cellSourceValue, deleteColumn, deleteRow, getTableWidths,
  insertColumn, insertRow, loadPersistedWidths, parseTable, serializeTable, setTableWidths, tableCellRange,
} from '../render/tableOps.js'

const controllers = new WeakMap()
const editors = new WeakMap()
const MIN_COLUMN = 48

export const tableSelection = Annotation.define()
export const currentTableText = wrap => controllers.get(wrap)?.text

export function tableSourceOffsetAt(wrap, target, x, y) {
  const controller = controllers.get(wrap)
  const cell = target?.closest?.('th,td')
  if (!controller || !cell || cell.closest('table') !== controller.table || controller.start() == null) return null
  return controller.point(cell, x, y)?.raw ?? null
}

export function updateTableDOM(wrap, previous, next) {
  const controller = controllers.get(wrap)
  if (!controller || controller.text !== previous || controller.expected !== next) return false
  controller.text = next
  return true
}

function relativeCell(cell) {
  return { row: cell.parentElement.rowIndex, col: cell.cellIndex }
}

function inputRange(input, position = offset => offset) {
  const start = position(input.selectionStart)
  const end = input.selectionEnd === input.selectionStart ? start : position(input.selectionEnd)
  return input.selectionDirection === 'backward' ? { anchor: end, head: start } : { anchor: start, head: end }
}

const sourceSelection = (input, from) => inputRange(input, offset => from + cellSourceValue(input.value.slice(0, offset)).length)

function graphemeOffset(value, position) {
  const offset = Math.min(value.length, Math.max(0, position))
  if (!offset || offset === value.length) return offset
  const before = findClusterBreak(value, offset, false)
  const after = findClusterBreak(value, before)
  return offset - before < after - offset ? before : after
}

function tableControllerAt(view, from, text) {
  for (const controller of editors.get(view) ?? []) {
    if (controller.text === text && controller.start() === from) return controller
  }
  return null
}

function enterAdjacentTable(view, key) {
  const { selection, doc, readOnly } = view.state
  if (readOnly || !view.hasFocus || selection.ranges.length !== 1 || !selection.main.empty || !editors.get(view)?.size) return false
  const range = selection.main
  const vertical = key === 'ArrowUp' || key === 'ArrowDown'
  const forward = vertical ? key === 'ArrowDown' : (key === 'ArrowRight') !== (view.textDirectionAt(range.head) === Direction.RTL)
  const line = doc.lineAt(range.head)
  const edge = forward ? line.to : line.from
  if (forward ? edge === doc.length : edge === 0) return false
  if (!vertical && range.head !== edge) return false
  const neighbour = edge + (forward ? 1 : -1)
  for (const controller of editors.get(view)) {
    if (controller.start(forward ? neighbour : neighbour - controller.text.length) == null) continue
    if (vertical && view.moveToLineBoundary(range, forward, true).head !== view.moveToLineBoundary(range, forward, false).head) return false
    const rows = controller.table.rows
    const row = rows[forward ? 0 : rows.length - 1]
    let cell = row.cells[forward ? 0 : row.cells.length - 1]
    let offset = forward ? 0 : Number.MAX_SAFE_INTEGER
    const position = vertical && view.coordsAtPos(range.head, range.assoc || 1)
    if (position) {
      const horizontal = (position.left + position.right) / 2
      let best = Infinity
      for (const candidate of row.cells) {
        const rect = candidate.getBoundingClientRect()
        const distance = Math.max(rect.left - horizontal, horizontal - rect.right, 0)
        if (distance < best) { cell = candidate; best = distance }
      }
      const rect = cell.getBoundingClientRect()
      offset = controller.point(cell, horizontal, forward ? rect.top + 1 : rect.bottom - 1)?.offset ?? offset
    }
    controller.open(cell, offset, offset, true)
    return true
  }
  return false
}

export const tableNavigationKeymap = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map(key => ({ key, run: view => enterAdjacentTable(view, key) }))

class CellEditor {
  constructor(wrap, table, view, getFrom, text, options) {
    this.wrap = wrap
    this.table = table
    this.view = view
    this.getFrom = getFrom
    this.text = text
    this.options = options
    this.doc = wrap.ownerDocument
    this.columnWidths = getTableWidths(text) ?? []
    this.persistedText = text
    this.pendingPointer = null
  }

  start(expected) {
    if (!this.wrap.isConnected || !this.view.contentDOM.contains(this.wrap)) return null
    if (expected != null) {
      if (expected < 0 || expected + this.text.length > this.view.state.doc.length) return null
      try { if (this.view.posAtDOM(this.wrap, 0) !== expected) return null } catch { return null }
    }
    const from = this.getFrom(this.text)
    return Number.isSafeInteger(from) && from >= 0 && from + this.text.length <= this.view.state.doc.length ? from : null
  }

  attach() {
    this.wrap.classList.add('md-live-table')
    this.colgroup = this.doc.createElement('colgroup')
    this.table.prepend(this.colgroup)
    for (const cell of this.table.rows[0].cells) this.colgroup.appendChild(this.doc.createElement('col'))
    this.table.style.tableLayout = 'fixed'
    this.tabStop = this.table.rows[0].cells[0]
    this.widths(this.columnWidths)
    void loadPersistedWidths().then(() => {
      if (controllers.get(this.wrap) !== this || this.active || this.drag || this.columnWidths.length) return
      this.columnWidths = getTableWidths(this.text) ?? []
      this.widths(this.columnWidths)
    })
    for (const row of this.table.rows) {
      for (const cell of row.cells) {
        const content = this.doc.createElement('span')
        content.className = 'md-table-cell-content'
        content.append(...cell.childNodes)
        cell.appendChild(content)
        cell.tabIndex = row.rowIndex === 0 && cell.cellIndex === 0 ? 0 : -1
        if (row.rowIndex === 0 && cell.cellIndex < row.cells.length - 1) {
          const handle = this.doc.createElement('span')
          handle.className = 'md-table-col-handle'
          handle.setAttribute('aria-hidden', 'true')
          cell.appendChild(handle)
        }
      }
    }
    this.listeners = new AbortController()
    const options = { signal: this.listeners.signal }
    this.table.addEventListener('pointerdown', event => this.pointerDown(event), options)
    this.table.addEventListener('pointermove', event => this.moveColumn(event), options)
    this.table.addEventListener('pointerup', event => this.finishDrag(event), options)
    this.table.addEventListener('pointercancel', event => this.finishDrag(event), options)
    this.table.addEventListener('keydown', event => {
      if (event.target.matches('th,td') && event.target.closest('table') === this.table && ['Enter', 'F2'].includes(event.key)) {
        event.preventDefault()
        this.open(event.target, 0, 0, true)
      }
    }, options)
    this.table.addEventListener('contextmenu', event => this.menu(event), options)
  }

  widths(values) {
    Array.from(this.colgroup.children).forEach((column, index) => { column.style.width = values[index] ? `${values[index]}px` : '' })
  }

  displayedWidths() {
    return Array.from(this.table.rows[0].cells, cell => cell.getBoundingClientRect().width)
  }

  rememberWidths() {
    if (this.columnWidths.length && this.persistedText !== this.text) setTableWidths(this.text, this.columnWidths)
    this.persistedText = this.text
  }

  point(cell, x, y) {
    const { row, col } = relativeCell(cell)
    const range = tableCellRange(this.text, row, col)
    if (!range) return null
    if (this.active?.cell === cell) {
      const { input, range: activeRange } = this.active
      const offset = input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd
      return { offset, raw: sourceSelection(input, activeRange.from).head }
    }
    const host = cell.querySelector('.md-table-cell-content')
    const visible = textPositionAtPoint(host, x, y)
    if (visible == null) return null
    const source = cellInputValue(range.value)
    const offset = cellTextOffset(source, host.textContent, visible.offset, {
      assoc: visible.assoc,
      renderHtml: this.options.renderHtml,
      formulae: Array.from(host.querySelectorAll('.md-inline-math'), math => math.textContent),
      decodeEntity: entity => {
        const decoder = this.doc.createElement('textarea')
        decoder.innerHTML = entity
        return decoder.value
      },
    })
    return { offset, raw: range.from + cellSourceValue(source.slice(0, offset)).length }
  }

  pointerDown(event) {
    if (event.button !== 0 || this.view.state.readOnly) return
    const cell = event.target.closest('th,td')
    if (!cell || cell.closest('table') !== this.table || event.target.closest('textarea')) return
    if (event.target.closest('a') && (event.metaKey || event.ctrlKey)) return
    const handle = event.target.closest('.md-table-col-handle')
    if (handle) {
      event.preventDefault()
      this.drag = { id: event.pointerId, handle, col: cell.cellIndex, x: event.clientX, initial: this.displayedWidths() }
      handle.setPointerCapture(event.pointerId)
      this.doc.body.classList.add('md-col-resizing')
      return
    }
    const start = this.point(cell, event.clientX, event.clientY)
    const from = this.start()
    if (!start || from == null) return
    event.preventDefault()
    if (event.shiftKey && !this.active) {
      this.view.dispatch({ selection: { anchor: this.view.state.selection.main.anchor, head: from + start.raw }, userEvent: 'select.pointer' })
      this.view.focus()
      return
    }
    this.pendingPointer?.abort()
    const pending = this.pendingPointer = new AbortController()
    const clear = () => { pending.abort(); if (this.pendingPointer === pending) this.pendingPointer = null }
    this.doc.addEventListener('pointercancel', clear, { signal: pending.signal })
    this.doc.defaultView.addEventListener('blur', clear, { signal: pending.signal })
    this.doc.addEventListener('pointerup', release => {
      if (release.pointerId !== event.pointerId) return
      clear()
      const currentFrom = this.start()
      if (currentFrom == null) return
      const endCell = this.doc.elementFromPoint(release.clientX, release.clientY)?.closest('th,td')
      if (endCell === cell) {
        const finish = this.point(cell, release.clientX, release.clientY)
        this.open(cell, start.offset, finish?.offset ?? start.offset)
      } else {
        const head = endCell?.closest('table') === this.table
          ? currentFrom + (this.point(endCell, release.clientX, release.clientY)?.raw ?? start.raw)
          : this.view.posAtCoords({ x: release.clientX, y: release.clientY })
        if (head == null) return
        this.close()
        this.view.dispatch({ selection: { anchor: currentFrom + start.raw, head }, userEvent: 'select.pointer' })
        this.view.focus()
      }
    }, { signal: pending.signal })
  }

  moveColumn(event) {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.id) return
    const widths = [...drag.initial]
    const minDelta = Math.min(0, MIN_COLUMN - widths[drag.col])
    const maxDelta = Math.max(0, widths[drag.col + 1] - MIN_COLUMN)
    const delta = Math.min(maxDelta, Math.max(minDelta, event.clientX - drag.x))
    widths[drag.col] += delta
    widths[drag.col + 1] -= delta
    drag.widths = widths
    this.widths(widths)
  }

  finishDrag(event) {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.id) return
    this.drag = null
    if (drag.handle.hasPointerCapture(drag.id)) drag.handle.releasePointerCapture(drag.id)
    this.doc.body.classList.remove('md-col-resizing')
    if (event.type === 'pointerup' && drag.widths && this.start() != null) {
      this.columnWidths = drag.widths
      setTableWidths(this.text, drag.widths)
      this.persistedText = this.text
    } else this.widths(this.columnWidths)
  }

  open(cell, anchor = 0, head = anchor, reveal = false) {
    if (!cell || cell.closest('table') !== this.table || this.start() == null || this.view.state.readOnly) return
    const { row, col } = relativeCell(cell)
    const range = tableCellRange(this.text, row, col)
    if (!range) return
    this.close()
    this.tabStop.tabIndex = -1
    this.tabStop = cell
    cell.tabIndex = 0
    const content = cell.querySelector('.md-table-cell-content')
    const input = this.doc.createElement('textarea')
    input.className = 'md-table-cell-editor'
    input.rows = 1
    input.spellcheck = false
    input.setAttribute('aria-label', `${row === 0 ? '表头' : `第 ${row} 行`}，第 ${col + 1} 列`)
    input.value = cellInputValue(range.value)
    this.widths(this.displayedWidths())
    const previous = this.doc.createDocumentFragment()
    previous.append(...content.childNodes)
    this.active = { cell, row, col, input, range, previous, dirty: false, first: true }
    cell.classList.add('md-table-cell-active')
    content.appendChild(input)
    input.addEventListener('compositionstart', () => {
      if (this.active?.input === input) { this.active.composing = true; this.active.compositionStart = true }
    })
    input.addEventListener('compositionend', () => { if (this.active?.input === input) this.active.composing = false })
    input.addEventListener('input', event => this.change(input, event))
    input.addEventListener('selectionchange', () => this.syncSelection(input))
    input.addEventListener('keydown', event => this.key(event))
    input.addEventListener('beforeinput', event => {
      if (!event.cancelable || this.active?.composing || !['historyUndo', 'historyRedo'].includes(event.inputType)) return
      event.preventDefault()
      this.history(event.inputType === 'historyUndo' ? undo : redo)
    })
    input.addEventListener('blur', () => {
      const active = this.active
      if (active?.input !== input || active.blurring) return
      if (active.composing) queueMicrotask(() => { if (this.active === active && !input.matches(':focus')) this.close() })
      else this.close()
    })
    input.focus({ preventScroll: true })
    input.setSelectionRange(graphemeOffset(input.value, Math.min(anchor, head)), graphemeOffset(input.value, Math.max(anchor, head)), anchor > head ? 'backward' : 'forward')
    this.syncSelection(input, true)
    if (reveal) input.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  syncSelection(input, force = false) {
    const active = this.active
    if (active?.input !== input || this.expected || !input.matches(':focus') || cellSourceValue(input.value) !== active.range.value) return
    const from = this.start()
    if (from == null) return
    const selection = sourceSelection(input, from + active.range.from)
    const current = this.view.state.selection.main
    if (!force && current.anchor === selection.anchor && current.head === selection.head) return
    this.view.dispatch({ selection, annotations: [tableSelection.of(true), Transaction.addToHistory.of(false)], userEvent: 'select.table' })
  }

  change(input, event) {
    const active = this.active
    const from = this.start()
    if (!active || active.input !== input || from == null || this.view.state.readOnly) return
    const { range } = active
    const encoded = cellSourceValue(input.value)
    if (encoded === range.value) return
    const replacement = range.prefix + encoded + range.suffix
    const diff = changedText(range.value, replacement)
    const next = this.text.slice(0, range.from) + replacement + this.text.slice(range.to)
    const userEvent = event.isComposing || active.composing ? (active.compositionStart ? 'input.type.compose.start' : 'input.type.compose')
      : event.inputType === 'format' ? 'input.format' : event.inputType === 'insertFromPaste' ? 'input.paste' : event.inputType?.startsWith('delete') ? 'delete' : 'input.type'
    const position = from + range.from
    const annotations = [tableSelection.of(true)]
    if (event.inputType === 'format' || active.first) annotations.push(isolateHistory.of(event.inputType === 'format' ? 'full' : 'before'))
    this.expected = next
    try {
      this.view.dispatch({
        changes: { from: position + diff.from, to: position + diff.to, insert: diff.insert }, userEvent,
        selection: sourceSelection(input, position + range.prefix.length),
        annotations,
      })
      if (this.active === active && this.text === next) {
        const cellFrom = range.from + range.prefix.length
        active.range = { from: cellFrom, to: cellFrom + encoded.length, value: encoded, prefix: '', suffix: '' }
        active.first = false
        active.compositionStart = false
        active.dirty = true
      }
    } finally { this.expected = null }
  }

  history(command) {
    const active = this.active
    const from = this.start()
    if (!active || from == null) return
    command({ state: this.view.state, dispatch: transaction => {
      const cellFrom = from + active.range.from, cellTo = from + active.range.to
      let local = true
      transaction.changes.iterChangedRanges((start, end) => { if (start < cellFrom || end > cellTo) local = false })
      if (!local) { this.close(); this.view.dispatch(transaction); this.view.focus(); return }
      const doc = transaction.newDoc
      const tableStart = transaction.changes.mapPos(from, -1)
      const next = doc.sliceString(tableStart, transaction.changes.mapPos(from + this.text.length, 1))
      const start = transaction.changes.mapPos(cellFrom, -1), end = transaction.changes.mapPos(cellTo, 1)
      const raw = doc.sliceString(start, end)
      const snapshot = this.view.scrollSnapshot().map(transaction.changes)
      this.expected = next
      try { this.view.dispatch(snapshot ? [transaction, transaction.state.update({ effects: snapshot })] : transaction) } finally { this.expected = null }
      if (this.active !== active || this.text !== next) return
      active.range = { from: start - tableStart, to: end - tableStart, value: raw, prefix: '', suffix: '' }
      active.dirty = true
      active.first = true
      active.input.value = cellInputValue(raw)
      const selection = transaction.newSelection.main
      const offset = position => cellInputValue(doc.sliceString(start, Math.min(end, Math.max(start, position)))).length
      active.input.setSelectionRange(offset(selection.from), offset(selection.to), selection.anchor > selection.head ? 'backward' : 'forward')
    } })
  }

  close() {
    const active = this.active
    if (!active) return
    if (active.composing && active.input.matches(':focus')) {
      active.blurring = true
      active.input.blur()
      if (this.active !== active) return
    }
    this.active = null
    const host = active.input.parentNode
    if (!host) return
    const raw = active.range.value
    host.replaceChildren(active.dirty ? this.options.renderCell?.(cellInputValue(raw)) ?? cellInputValue(raw) : active.previous)
    active.cell.classList.remove('md-table-cell-active')
    this.rememberWidths()
    this.widths(this.columnWidths)
    this.view.requestMeasure()
  }

  exit(direction, createParagraph = false, returnToCell = false) {
    const from = this.start()
    if (from == null) return
    const to = from + this.text.length, length = this.view.state.doc.length
    const cell = this.active?.cell
    const anchor = direction < 0 && from > 0 ? from - 1 : direction > 0 && to < length ? to + 1 : null
    const append = direction > 0 && to === length && createParagraph
    if (anchor == null && !append) {
      if (returnToCell) { this.close(); cell?.focus({ preventScroll: true }) }
      return
    }
    this.close()
    if (append) {
      this.view.dispatch({ changes: { from: to, insert: '\n' }, selection: { anchor: to + 1 }, scrollIntoView: true, userEvent: 'input' })
    } else {
      this.view.dispatch({ selection: { anchor }, scrollIntoView: true, userEvent: 'select' })
    }
    this.view.focus()
  }

  format(input, key, shift) {
    const state = EditorState.create({ doc: input.value, selection: inputRange(input) })
    const cellView = {
      state, focus() {}, dispatch: (...specs) => {
        const transaction = state.update(...specs)
        const range = transaction.newSelection.main
        input.value = transaction.newDoc.toString()
        input.setSelectionRange(range.from, range.to, range.anchor > range.head ? 'backward' : 'forward')
        this.change(input, { inputType: 'format' })
      },
    }
    if (key === 'k') insertBlock(cellView, shift ? IMAGE_TEXT : LINK_TEXT)
    else wrapSelection(cellView, { b: '**', i: '*', e: '`' }[key])
  }

  key(event) {
    const active = this.active
    if (!active || active.composing || event.isComposing || event.keyCode === 229) return
    const { input, row, col } = active
    const mod = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    if (mod && !event.shiftKey && !event.altKey && key === '/' && this.options.requestSourceMode) {
      event.preventDefault()
      event.stopPropagation()
      this.syncSelection(input)
      this.options.requestSourceMode()
      return
    }
    if (mod && !event.altKey && (key === 'z' || key === 'y')) {
      event.preventDefault()
      this.history(key === 'z' && !event.shiftKey ? undo : redo)
      return
    }
    if (mod && !event.altKey && (key === 'k' || !event.shiftKey && ['b', 'i', 'e'].includes(key))) {
      event.preventDefault()
      event.stopPropagation()
      if (!this.view.state.readOnly && this.start() != null) this.format(input, key, event.shiftKey)
      return
    }
    if (mod || event.altKey || !['Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
    if (event.key === 'Enter' && event.shiftKey) return
    const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp'
    const horizontal = event.key === 'ArrowRight' || event.key === 'ArrowLeft'
    const backwards = horizontal ? (event.key === 'ArrowLeft') !== (this.doc.defaultView.getComputedStyle(input).direction === 'rtl') : event.key === 'ArrowUp' || event.shiftKey
    if (vertical || horizontal) {
      if (event.shiftKey || input.selectionStart !== input.selectionEnd) return
      const onEdge = backwards ? input.selectionStart === 0 : input.selectionEnd === input.value.length
      const lineHeight = vertical && parseFloat(this.doc.defaultView.getComputedStyle(input).lineHeight)
      if (!onEdge && (!vertical || !lineHeight || input.getBoundingClientRect().height > lineHeight + 1)) return
    }
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') { this.exit(this.start() + this.text.length < this.view.state.doc.length ? 1 : -1, false, true); return }
    const columns = this.table.rows[0].cells.length
    const direction = backwards ? -1 : 1
    const flat = row * columns + col + (event.key === 'Tab' || horizontal ? direction : direction * columns)
    const next = flat >= 0 && this.table.rows[Math.floor(flat / columns)]?.cells[flat % columns]
    if (next) {
      const offset = vertical ? input.selectionStart : horizontal && backwards ? Number.MAX_SAFE_INTEGER : 0
      this.open(next, offset, offset, true)
    }
    else if (event.key === 'Tab' && direction > 0) {
      const parsed = parseTable(this.text)
      if (parsed) this.structure(insertRow(parsed, parsed.rows.length), this.columnWidths, { row: this.table.rows.length, col: 0 })
    } else this.exit(direction, event.key === 'Enter', event.key === 'Tab')
  }

  structure(parsed, widths, target) {
    const from = this.start()
    if (from == null || this.view.state.readOnly) return
    const next = serializeTable(parsed)
    if (next === this.text) return
    this.close()
    const diff = changedText(this.text, next)
    if (widths.length) setTableWidths(next, widths)
    this.view.dispatch({ changes: { from: from + diff.from, to: from + diff.to, insert: diff.insert }, userEvent: 'input', annotations: isolateHistory.of('full') })
    if (target) {
      const controller = tableControllerAt(this.view, from, next)
      if (controller) controller.open(controller.table.rows[target.row]?.cells[target.col], 0, 0, true)
    }
  }

  menu(event) {
    const cell = event.target.closest('th,td')
    const from = this.start()
    if (!cell || cell.closest('table') !== this.table || from == null || this.view.state.readOnly) return
    event.preventDefault()
    event.stopPropagation()
    const { row, col } = relativeCell(cell)
    const original = this.text
    const parsed = parseTable(original)
    if (!parsed) return
    const context = new AbortController()
    this.menuCleanup?.()
    const menu = this.doc.createElement('div')
    menu.className = 'md-table-menu'
    menu.setAttribute('role', 'group')
    menu.setAttribute('aria-label', '表格操作')
    this.menuCleanup = () => { context.abort(); menu.remove(); this.menuCleanup = null }
    const item = (label, action, disabled = false) => {
      const button = this.doc.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.disabled = disabled
      button.addEventListener('click', () => {
        this.menuCleanup?.()
        if (this.start() != null && this.text === original && !this.view.state.readOnly) action()
      })
      menu.appendChild(button)
    }
    const changeColumns = (at, deleting) => {
      const widths = [...this.columnWidths]
      if (widths.length) widths.splice(at, deleting ? 1 : 0, ...(deleting ? [] : [widths[col] || MIN_COLUMN]))
      this.structure(deleting ? deleteColumn(parsed, at) : insertColumn(parsed, at), widths)
    }
    item('向左插入列', () => changeColumns(col, false))
    item('向右插入列', () => changeColumns(col + 1, false))
    item('删除此列', () => changeColumns(col, true), parsed.header.length <= 1)
    item('向上插入行', () => this.structure(insertRow(parsed, row - 1), this.columnWidths), row === 0)
    item('向下插入行', () => this.structure(insertRow(parsed, row), this.columnWidths))
    item('删除此行', () => this.structure(deleteRow(parsed, row - 1), this.columnWidths), row === 0)
    item('重置列宽', () => { this.columnWidths = []; this.widths([]); setTableWidths(this.text, []) })
    item('编辑表格源码', () => {
      const range = tableCellRange(this.text, row, col)
      if (!range) return
      this.close()
      const start = this.start()
      if (start != null) this.options.requestSource?.(start + range.from)
    })
    this.doc.body.appendChild(menu)
    const rect = menu.getBoundingClientRect(), win = this.doc.defaultView
    menu.style.left = `${Math.max(4, Math.min(event.clientX, win.innerWidth - rect.width - 4))}px`
    menu.style.top = `${Math.max(4, Math.min(event.clientY, win.innerHeight - rect.height - 4))}px`
    this.doc.addEventListener('pointerdown', press => { if (!menu.contains(press.target)) this.menuCleanup?.() }, { capture: true, signal: context.signal })
    this.doc.addEventListener('keydown', key => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); this.menuCleanup?.(); cell.focus() } }, { capture: true, signal: context.signal })
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
  }

  dispose() {
    this.listeners.abort()
    this.pendingPointer?.abort()
    this.menuCleanup?.()
    if (this.drag) this.doc.body.classList.remove('md-col-resizing')
    this.active = null
    this.rememberWidths()
  }
}

export function wireTable(wrap, view, getFrom, text, options = {}) {
  const table = wrap.querySelector('table.md-table')
  if (!table?.rows[0] || !parseTable(text)) return
  const controller = new CellEditor(wrap, table, view, getFrom, text, options)
  controllers.set(wrap, controller)
  if (!editors.has(view)) editors.set(view, new Set())
  editors.get(view).add(controller)
  controller.attach()
  return () => { controllers.delete(wrap); editors.get(view)?.delete(controller); controller.dispose() }
}
