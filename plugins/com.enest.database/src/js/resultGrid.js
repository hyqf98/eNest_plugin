/**
 * resultGrid.js — 结果网格：虚拟滚动、行状态 CRUD、变更集
 * 可见控件极少：状态徽标；选中行/有脏变更时出现选择条
 * 提交/放弃仅在存在脏变更时出现；其余走右键
 */
import { toast, clipboardWrite } from './api.js'
import { openValueInspector, structuredValue } from './documentInspector.js'
import { uid } from './store.js'
import { openCtxMenu } from './ctxMenu.js'
import { enhanceSelect } from './dropdown.js'
import { createDialog } from '@enest/plugin-kit/workbench'
import { parseGridTsv, gridTsv, coerceGridValue, quoteGridIdentifier } from './gridProductivity.js'
import { createGridLayout, estimateColumnWidth, columnAlignment } from './gridLayout.js'

const ROW_H = 28
const hasBufferedValues = state => state && (state.status === 'inserted' || state.status === 'dirty' || state.status === 'failed' && state.failType !== 'deleted')

// Shared by visible and background results. This function never reads the active grid or DOM.
function applyBatchToBuffer(buffer, batchResult, changes) {
  const results = batchResult?.results || []
  buffer.committedDeletedRows ||= new Set()
  // Missing outcomes keep their original local buffers and must never announce success.
  let anyFail = batchResult?.ok === false || results.length < changes.length
  results.forEach((result, index) => {
    const batchIndex = typeof result?.index === 'number' ? result.index : index
    const source = changes[batchIndex]
    const rowIndex = source?._idx ?? buffer.lastChangeIdxs?.[batchIndex] ?? buffer._lastChangeIdxs?.[batchIndex]
    if (rowIndex == null) return
    const row = buffer.rowState.get(rowIndex)
    if (!row) return
    if (result.ok) {
      if (source?.type === 'delete') {
        buffer.committedDeletedRows.add(rowIndex)
        buffer.rowState.delete(rowIndex)
        buffer.selectedRows?.delete(rowIndex)
        if (buffer.cellSel?.row === rowIndex) buffer.cellSel = null
      } else if (row.insert || row.status === 'inserted') {
        const inserted = buffer.insertedRows.find(item => item._idx === rowIndex)
        if (inserted) inserted.values = row.current.slice()
        row.original = row.current.slice(); row.status = 'clean'; row.insert = false
        row.committedInsert = true; row.error = ''; delete row.failType
      } else {
        row.original = row.current ? row.current.slice() : row.original
        // Result rows are shared as read-only data between snapshots; replace instead of mutating.
        if (source?.type === 'update' && row.current) {
          buffer.rows = buffer.rows.slice()
          buffer.rows[rowIndex] = row.current.slice()
        }
        row.status = 'clean'
        row.error = ''
        row.key = { ...(row.key || source?.key || {}) }
        if (source?.type === 'update' && buffer.rowIdentity?.keyColumns?.length) {
          for (const name of buffer.rowIdentity.keyColumns) if (Object.hasOwn(source.set || {}, name)) row.key[name] = source.set[name]
          const keys = [...(buffer.rowIdentity.keys || [])]
          keys[rowIndex] = buffer.rowIdentity.keyColumns.map(name => row.key[name])
          buffer.rowIdentity = { ...buffer.rowIdentity, keys }
        }
        delete row.failType
      }
    } else {
      row.failType = row.insert ? 'inserted' : row.status === 'deleted' || row.failType === 'deleted' ? 'deleted' : 'dirty'
      row.status = 'failed'
      row.error = result.error || '提交失败'
      anyFail = true
    }
  })
  return { anyFail, results }
}

export class ResultGrid {
  constructor(root, opts = {}) {
    this.root = root
    this.onSelectionChange = opts.onSelectionChange || (() => {})
    this.onCommit = opts.onCommit || (() => {})
    this.onRevert = opts.onRevert || (() => {})
    this.onExport = opts.onExport || (() => {})
    this.onImport = opts.onImport || (() => {})
    this.onGenerateSql = opts.onGenerateSql || (() => {})
    this.onRefresh = opts.onRefresh || (() => {})
    this.onExportCsv = opts.onExportCsv || null
    this.onContextMenu = opts.onContextMenu || null
    this.onServerSort = opts.onServerSort || (() => {})
    this.onServerFilter = opts.onServerFilter || (() => {})
    this.isMutationLocked = opts.isMutationLocked || (() => false)
    this.onPageChange = opts.onPageChange || (() => {})
    this.onPageSizeChange = opts.onPageSizeChange || (() => {})
    this.data = null
    this.tableRef = null
    this.editable = false
    this.driverUpdatable = false
    this.readOnly = false
    this.rowIdentity = null
    this.columns = []
    this.rows = []
    this.rowState = new Map()
    this.insertedRows = []
    this.committedDeletedRows = new Set()
    this.selectedRows = new Set()
    this.cellSel = null
    this.selectionAnchor = null
    this.undoStack = []
    this.redoStack = []
    this.dialect = opts.dialect || 'mysql'
    // —— 视图层（排序 / 筛选 / 分页）：仅决定展示顺序，模型行索引（rows/rowState/selectedRows 键）不变 ——
    this.sortCol = null // 列索引 | null
    this.sortDir = null // 'asc' | 'desc' | null（三态：none → asc → desc → none）
    this.filterOpen = false
    this.filters = {} // 列索引 -> 关键词（contains，客户端过滤）
    this.page = 0
    this.pageSize = Number(opts.pageSize) > 0 ? Number(opts.pageSize) : 200
    this.viewAllIdxs = [] // 筛选+排序后的全部模型行索引（不含新增行）
    this.viewIdxs = [] // 当前页切片 + 新增行，_renderRows 按此渲染
    this.rowHeight = ROW_H
    this.columnWidths = {}
    this._build()
    this._bind()
  }

  _build() {
    this.root.innerHTML = `
      <div class="grid-bar">
        <span class="badge" data-el="badge">—</span>
        <div class="grid-selbar" data-el="selbar" hidden></div>
        <div class="spacer"></div>
        <button type="button" class="btn sm rg-filter-toggle" data-el="filterToggle" hidden title="列筛选">筛选</button>
        <span class="grid-meta" data-el="status"></span>
      </div>
      <div class="grid-body" data-el="body">
        <div data-el="rowMetric" aria-hidden="true" style="position:absolute;top:0;left:0;width:0;height:var(--db-row-height,28px);visibility:hidden;pointer-events:none;contain:strict"></div>
        <div class="grid-head" data-el="head"></div>
        <div class="grid-viewport" data-el="viewport" tabindex="0" role="grid" aria-label="查询结果，方向键移动，F2 编辑，Shift 空格选行">
          <div class="grid-canvas" data-el="canvas"></div>
        </div>
        <input class="cell-editor" data-el="cellEditor" hidden />
      </div>
      <div class="rg-pager" data-el="pager" hidden></div>
      <div class="grid-cellview" data-el="cellview" hidden></div>
    `
    this.el = {
      badge: this.root.querySelector('[data-el=badge]'),
      selbar: this.root.querySelector('[data-el=selbar]'),
      filterToggle: this.root.querySelector('[data-el=filterToggle]'),
      head: this.root.querySelector('[data-el=head]'),
      viewport: this.root.querySelector('[data-el=viewport]'),
      canvas: this.root.querySelector('[data-el=canvas]'),
      status: this.root.querySelector('[data-el=status]'),
      cellEditor: this.root.querySelector('[data-el=cellEditor]'),
      pager: this.root.querySelector('[data-el=pager]'),
      cellview: this.root.querySelector('[data-el=cellview]')
    }
    this.el.rowMetric = this.root.querySelector('[data-el=rowMetric]')
    this.el.body = this.root.querySelector('[data-el=body]')
  }

  _bind() {
    // Resolve CSS calc/rem once per size change, never on the scrolling hot path.
    this.rowHeightObserver = new ResizeObserver(([entry]) => this._setRowHeight(entry.contentRect.height))
    this.rowHeightObserver.observe(this.el.rowMetric)
    this.viewportObserver = new ResizeObserver(() => {
      if (!this.el.viewport.clientHeight) return
      this._applyColumnLayout()
      if (this._renderedHeight !== this.el.viewport.clientHeight) this._renderRows({ preserveEditor: true })
    })
    this.viewportObserver.observe(this.el.viewport)
    window.addEventListener('pagehide', () => { this.rowHeightObserver.disconnect(); this.viewportObserver.disconnect() }, { once: true })
    this.el.selbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sel]')
      if (!btn) return
      const k = btn.dataset.sel
      if (k === 'commit') this.onCommit()
      else if (k === 'revert') this.revertAll()
      else if (k === 'insert') this.insertRow()
      else if (k === 'batch') this.openBatchEditor()
      else if (k === 'delete') this.markDeleteSelected()
      else if (k === 'undo') this.undoLocal()
      else if (k === 'more') this.openOverflowMenu(e)
    })

    this.el.viewport.addEventListener('contextmenu', (e) => {
      const rowEl = e.target.closest('[data-row]')
      const cell = e.target.closest('[data-r][data-c]')
      if (cell) {
        this.cellSel = { row: Number(cell.dataset.r), col: cell.dataset.c }
        this._renderRows()
      } else if (rowEl) {
        const idx = Number(rowEl.dataset.row)
        if (!this.selectedRows.has(idx)) this.selectedRows = new Set([idx])
        this.cellSel = { row: idx, col: this.cellSel?.col || '0' }
        this._renderRows()
        this.onSelectionChange(this.selectedRows)
      }
      e.preventDefault()
      if (this.onContextMenu) this.onContextMenu(e, this.cellSel)
      else this.openCellContextMenu(e)
    })

    this.el.viewport.addEventListener('scroll', () => {
      this._syncHorizontalScroll()
      if (this._renderedScrollTop !== this.el.viewport.scrollTop) this._renderRows()
    })
    // Trackpads and Shift+wheel over the header scroll the same body, without a second scroller.
    this.el.head.addEventListener('wheel', event => {
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0)
      if (!delta || this.el.viewport.scrollWidth <= this.el.viewport.clientWidth) return
      event.preventDefault()
      this.el.viewport.scrollLeft += delta * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? this.el.viewport.clientWidth : 1)
      this._syncHorizontalScroll()
    }, { passive: false })
    this.el.viewport.addEventListener('dblclick', (e) => {
      const cell = e.target.closest('[data-r][data-c]')
      if (!cell) return
      const value = this._sortRow(Number(cell.dataset.r))?.[Number(cell.dataset.c)]
      if (structuredValue(value) || !this.editable) openValueInspector(value, this.columns[Number(cell.dataset.c)]?.name || '单元格详情')
      else this._beginEdit(cell.dataset.r, cell.dataset.c)
    })
    this.el.viewport.addEventListener('click', (e) => {
      const rowEl = e.target.closest('[data-row]')
      if (!rowEl) return
      const idx = Number(rowEl.dataset.row)
      if (e.target.classList.contains('row-check')) {
        this._selectRow(idx, e.shiftKey, e.target.checked)
        this._renderRows()
        this.onSelectionChange(this.selectedRows)
        return
      }
      const cell = e.target.closest('[data-r][data-c]')
      if (!cell && e.target.closest('.td.idx')) {
        this._selectRow(idx, e.shiftKey, !this.selectedRows.has(idx))
        this._renderRows(); this.onSelectionChange(this.selectedRows); this.el.viewport.focus({ preventScroll: true }); return
      }
      this.cellSel = cell ? { row: Number(rowEl.dataset.row), col: cell.dataset.c } : null
      if (e.shiftKey && cell) { this._selectRow(idx, true, true); this._renderRows(); this.onSelectionChange(this.selectedRows) }
      else if (cell) this.selectionAnchor = idx
      // Preserve the target node so the browser can deliver double-click and text selection.
      this.el.canvas.querySelectorAll('.cell-active').forEach((item) => item.classList.remove('cell-active'))
      cell?.classList.add('cell-active')
      if (cell) this.el.viewport.focus({ preventScroll: true })
    })
    this.el.cellEditor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        this._commitEdit()
        this.el.viewport.focus({ preventScroll: true })
      } else if (e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation(); this._commitEdit(); this._moveCell(0, e.shiftKey ? -1 : 1, false, true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this._cancelEdit()
        this.el.viewport.focus({ preventScroll: true })
      }
    })
    this.el.cellEditor.addEventListener('blur', () => { if (!this._movingEditor) this._commitEdit() })

    this.el.head.addEventListener('click', (e) => {
      const th = e.target.closest('.th[data-c]')
      if (!th || e.target.closest('input, [data-resize-column]')) return
      this._cycleSort(Number(th.dataset.c))
    })
    this.el.head.addEventListener('pointerdown', event => this._startColumnResize(event))
    this.el.head.addEventListener('focusin', event => {
      const header = event.target.closest('.th[data-c], .th[data-fc]')
      if (header) this._revealColumn(Number(header.dataset.c ?? header.dataset.fc))
    })
    this.el.head.addEventListener('dblclick', event => {
      const handle = event.target.closest('[data-resize-column]')
      if (!handle) return
      event.preventDefault(); event.stopPropagation()
      this._fitColumn(Number(handle.dataset.resizeColumn))
    })
    this.el.head.addEventListener('contextmenu', (event) => {
      const cell = event.target.closest('.th[data-c]'); if (!cell) return
      event.preventDefault(); this.openColumnContextMenu(event, Number(cell.dataset.c))
    })
    this.el.head.addEventListener('keydown', (event) => {
      const handle = event.target.closest('[data-resize-column]')
      if (handle) {
        const column = Number(handle.dataset.resizeColumn)
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'Escape'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        if (event.key === 'Home') this._fitColumn(column)
        else if (event.key === 'Escape') handle.closest('[role=columnheader]')?.focus()
        else this._setColumnWidth(column, this._columnLayout().widths[column] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 32 : 8))
        return
      }
      const cell = event.target.closest('.th[data-c]'); if (!cell) return
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); this._cycleSort(Number(cell.dataset.c)) }
    })
    this.el.head.addEventListener('input', (e) => {
      const inp = e.target.closest('[data-filter-c]')
      if (!inp) return
      this.filters[Number(inp.dataset.filterC)] = inp.value
      this._applyView({ resetScroll: true })
    })

    this.el.filterToggle.addEventListener('click', () => {
      this.filterOpen = !this.filterOpen
      if (!this.filterOpen) this.filters = {}
      this._renderHead()
      this._applyView({ resetScroll: true })
    })

    this.el.pager.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pager]')
      if (!btn) return
      const k = btn.dataset.pager
      if (k === 'prev') this.page = Math.max(0, this.page - 1)
      else if (k === 'next') this.page = Math.min(this._pageCount() - 1, this.page + 1)
      else if (k === 'go') {
        const v = Number(btn.dataset.page)
        if (Number.isFinite(v)) this.page = Math.min(Math.max(0, v), this._pageCount() - 1)
      }
      this._applyView({ resetScroll: true })
    })
    this.el.pager.addEventListener('change', (e) => {
      if (e.target.dataset?.pagerSelect !== 'size') return
      const v = Number(e.target.value)
      if (!Number.isFinite(v) || v <= 0) return
      this.pageSize = v
      this.page = 0
      this.onPageSizeChange(v)
      this._applyView({ resetScroll: true })
    })

    this.root.addEventListener('keydown', (event) => this._gridKey(event))
    this.el.viewport.addEventListener('paste', (event) => {
      if (event.target.closest('input,textarea,[contenteditable=true]')) return
      if (!event.clipboardData?.types.includes('text/plain')) return
      event.preventDefault(); event.stopPropagation()
      this.pasteCells(event.clipboardData?.getData('text/plain') || '')
    })
    this.root.tabIndex = 0
  }

  _setRowHeight(height) {
    if (!Number.isFinite(height) || height <= 0 || Math.abs(height - this.rowHeight) < 0.01) return
    this._commitEdit()
    const anchor = this.el.viewport.scrollTop / this.rowHeight
    this.rowHeight = height
    this._applyColumnLayout()
    this._renderRows()
    this.el.viewport.scrollTop = anchor * height
    this._renderRows()
  }

  setDialect(dialect) { this.dialect = dialect || 'mysql' }

  _bufferSnapshot() {
    return structuredClone({ rowState: this.rowState, insertedRows: this.insertedRows, selectedRows: this.selectedRows, cellSel: this.cellSel })
  }

  _recordUndo() {
    this.undoStack.push(this._bufferSnapshot())
    if (this.undoStack.length > 20) this.undoStack.shift()
    this.redoStack = []
  }

  undoLocal(redo = false) {
    if (this.isMutationLocked() || this.readOnly || !this.editable) return false
    this._commitEdit()
    const from = redo ? this.redoStack : this.undoStack, to = redo ? this.undoStack : this.redoStack
    if (!from.length) return false
    to.push(this._bufferSnapshot())
    Object.assign(this, from.pop())
    this._applyView(); this.onSelectionChange(this.selectedRows); this.onRevert()
    return true
  }

  _rowProblem(index) {
    if (this.isMutationLocked()) return '此结果正在执行任务，完成后再编辑'
    if (this.readOnly || !this.editable) return '当前结果集只读'
    const row = this._getRow(index), state = this.rowState.get(index)
    if (!row) return '目标行已不存在'
    if (state?.committedInsert) return '此行已写入，请刷新取得数据库默认值和主键后再修改'
    if (state?.status === 'deleted' || state?.status === 'failed' && state.failType === 'deleted') return '请先撤销该行的删除标记'
    if (index < this.rows.length && !this._keyOf(index)) return '此行没有主键，无法安全修改'
    return ''
  }

  _cellProblem(index, column, value) {
    const problem = this._rowProblem(index)
    if (problem) return problem
    const definition = this.columns[column]
    if (!definition) return '目标列已不存在'
    if (definition.readOnly || definition.readonly || definition.editable === false || definition.generated || definition.autoGenerated || definition.autoIncrement) return `${this._colLabel(definition)} 是只读或自动生成字段`
    if (value === null && (definition.nullable === false || this._isPrimaryColumn(column))) return `${this._colLabel(definition)} 不能设为 NULL`
    return ''
  }

  _targetRows() {
    if (this.selectedRows.size) return [...this.selectedRows].filter(index => this._getRow(index))
    return this.cellSel && this._getRow(this.cellSel.row) ? [this.cellSel.row] : []
  }

  _selectRow(index, range = false, selected = true) {
    const anchor = this.viewIdxs.indexOf(this.selectionAnchor), end = this.viewIdxs.indexOf(index)
    const indices = range && anchor >= 0 && end >= 0 ? this.viewIdxs.slice(Math.min(anchor, end), Math.max(anchor, end) + 1) : [index]
    indices.forEach(item => selected ? this.selectedRows.add(item) : this.selectedRows.delete(item))
    if (!range || anchor < 0) this.selectionAnchor = index
  }

  _moveCell(rows, columns, range = false, wrap = false) {
    if (!this.viewIdxs.length || !this.columns.length) return
    let position = Math.max(0, this.viewIdxs.indexOf(this.cellSel?.row)), column = Number(this.cellSel?.col || 0) + columns
    if (wrap && column >= this.columns.length) { position++; column = 0 }
    else if (wrap && column < 0) { position--; column = this.columns.length - 1 }
    position = Math.min(this.viewIdxs.length - 1, Math.max(0, position + rows))
    column = Math.min(this.columns.length - 1, Math.max(0, column))
    const index = this.viewIdxs[position]
    if (range) this._selectRow(index, true, true)
    else this.selectionAnchor = index
    this.cellSel = { row: index, col: String(column) }
    const top = position * this.rowHeight, viewport = this.el.viewport
    if (top < viewport.scrollTop) viewport.scrollTop = top
    else if (top + this.rowHeight > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + this.rowHeight - viewport.clientHeight
    this._renderRows()
    this._revealColumn(column)
    viewport.focus({ preventScroll: true })
    if (range) this.onSelectionChange(this.selectedRows)
  }

  _gridKey(event) {
    if (event.defaultPrevented) return
    if (!this.el.viewport.contains(event.target) || event.target.closest('input,textarea,button,select,[contenteditable=true]')) return
    const mod = event.metaKey || event.ctrlKey, key = event.key.toLowerCase()
    let handled = true
    if (mod && key === 'a') this.selectAllVisible()
    else if (mod && key === 'c') this.selectedRows.size ? this.copyRows('tsv') : this.copyActiveCell()
    else if (mod && key === 'z') this.undoLocal(event.shiftKey)
    else if (mod && key === 'y') this.undoLocal(true)
    else if (mod && event.key === 'Enter') this.onCommit()
    else if (event.key === 'F2' || event.key === 'Enter') { if (this.cellSel) this._beginEdit(this.cellSel.row, this.cellSel.col) }
    else if (event.key === ' ' && event.shiftKey && this.cellSel) { this._selectRow(this.cellSel.row, false, !this.selectedRows.has(this.cellSel.row)); this._renderRows(); this.onSelectionChange(this.selectedRows) }
    else if (event.key === 'Delete' && (this.selectedRows.size || event.shiftKey)) this.markDeleteSelected()
    else if (event.key === 'Escape') { this.selectedRows.clear(); this._renderRows(); this.onSelectionChange(this.selectedRows) }
    else if (event.key === 'ArrowDown') this._moveCell(1, 0, event.shiftKey)
    else if (event.key === 'ArrowUp') this._moveCell(-1, 0, event.shiftKey)
    else if (event.key === 'ArrowRight') this._moveCell(0, 1)
    else if (event.key === 'ArrowLeft') this._moveCell(0, -1)
    else if (event.key === 'Tab' && this.cellSel) this._moveCell(0, event.shiftKey ? -1 : 1, false, true)
    else if (event.key === 'Home') this._moveCell(mod ? -this.viewIdxs.length : 0, -this.columns.length, event.shiftKey)
    else if (event.key === 'End') this._moveCell(mod ? this.viewIdxs.length : 0, this.columns.length, event.shiftKey)
    else handled = false
    if (handled) { event.preventDefault(); event.stopPropagation() }
  }

  applyCellEdits(edits) {
    this._commitEdit()
    if (!edits.length) return 0
    const prepared = edits.map(({ row, column, value }) => {
      const converted = coerceGridValue(value, this.columns[column]), problem = this._cellProblem(row, column, converted)
      if (problem) throw new Error(problem)
      return { row, column, value: converted }
    })
    const changed = prepared.filter(item => this._sortRow(item.row)?.[item.column] !== item.value)
    if (!changed.length) return 0
    this._recordUndo()
    changed.forEach(item => this._applyCell(item.row, item.column, item.value, false))
    this._applyView(); this.onSelectionChange(this.selectedRows)
    return changed.length
  }

  pasteCells(text) {
    try {
      if (!this.cellSel) throw new Error('请先选中粘贴起点单元格')
      const matrix = parseGridTsv(text), startRow = this.viewIdxs.indexOf(this.cellSel.row), startColumn = Number(this.cellSel.col)
      if (startRow < 0 || startRow + matrix.length > this.viewIdxs.length || startColumn + matrix[0].length > this.columns.length) throw new Error('粘贴区域超出当前页已有行列；请缩小区域或先新增行')
      const edits = matrix.flatMap((row, index) => row.map((value, offset) => ({ row: this.viewIdxs[startRow + index], column: startColumn + offset, value })))
      const count = this.applyCellEdits(edits)
      if (count) toast(`已粘贴 ${count} 个单元格，等待提交`, 'info')
      return count
    } catch (error) { toast(error.message, 'warn'); return false }
  }

  openBatchEditor(column = Number(this.cellSel?.col || 0)) {
    const indices = this._targetRows()
    if (!indices.length) { toast('请先选择要修改的行', 'warn'); return }
    const source = this.rowState
    let applied = false
    const modal = createDialog({ title: '批量编辑选中行', className: 'rg-batch-dialog', content: `<p class="rg-batch-scope">修改 ${indices.length} 行的同一字段，所有变更先保留在本地。</p><div class="form-grid"><label>字段<select data-batch-column>${this.columns.map((item, index) => `<option value="${index}" ${index === column ? 'selected' : ''}>${escape(this._colLabel(item))}</option>`).join('')}</select></label><label>操作<select data-batch-mode><option value="value">设为指定值</option><option value="null">设为 NULL</option></select></label><label class="span2">值<input data-batch-value autocomplete="off"></label></div><p data-batch-error role="status"></p><div class="form-actions"><button class="btn" data-batch-cancel>取消</button><button class="btn primary" data-batch-apply>应用到本地</button></div>` })
    const body = modal.body, value = body.querySelector('[data-batch-value]'), mode = body.querySelector('[data-batch-mode]')
    modal.dialog.addEventListener('close', () => { if (applied) this.el.viewport.focus({ preventScroll: true }) }, { once: true })
    mode.onchange = () => { value.disabled = mode.value === 'null' }
    body.querySelector('[data-batch-cancel]').onclick = () => modal.close()
    body.querySelector('[data-batch-apply]').onclick = () => {
      try {
        if (this.rowState !== source) throw new Error('结果已切换，请在原结果中重新打开批量编辑')
        const ci = Number(body.querySelector('[data-batch-column]').value)
        if (indices.length > 1 && this._isPrimaryColumn(ci)) throw new Error('主键请逐行修改，不能为多行设置相同主键')
        const count = this.applyCellEdits(indices.map(row => ({ row, column: ci, value: mode.value === 'null' ? null : value.value })))
        applied = true; modal.close(); if (count) toast(`已修改 ${indices.length} 行，等待提交`, 'info')
      } catch (error) { body.querySelector('[data-batch-error]').textContent = error.message }
    }
  }

  selectAllVisible() { this.selectedRows = new Set(this.viewIdxs); this._renderRows(); this.onSelectionChange(this.selectedRows) }
  duplicateSelectedRows() { return this.duplicateRow() }
  revertSelectedRows() { return this.revertSelected() }
  openBulkEdit(column) { return this.openBatchEditor(column) }

  openPasteDialog() {
    if (!this.cellSel) { toast('请先选中粘贴起点单元格', 'warn'); return }
    const source = this.rowState
    let applied = false
    const modal = createDialog({ title: '粘贴表格数据', className: 'rg-batch-dialog', content: '<p class="rg-batch-scope">粘贴 Excel 或 TSV 内容。从当前单元格开始，仅修改当前页已有行列。字符串 NULL 按文本保留；设为空值请使用批量编辑。</p><textarea class="wb-sql-preview" data-grid-paste aria-label="待粘贴表格内容" rows="8"></textarea><p data-batch-error role="status"></p><div class="form-actions"><button class="btn" data-paste-cancel>取消</button><button class="btn primary" data-paste-apply>应用到本地</button></div>' })
    modal.body.querySelector('[data-paste-cancel]').onclick = () => modal.close()
    modal.dialog.addEventListener('close', () => { if (applied) this.el.viewport.focus({ preventScroll: true }) }, { once: true })
    modal.body.querySelector('[data-paste-apply]').onclick = () => {
      if (source !== this.rowState) { modal.body.querySelector('[data-batch-error]').textContent = '结果已切换，请重新打开粘贴'; return }
      const input = modal.body.querySelector('[data-grid-paste]').value
      if (!input) { modal.body.querySelector('[data-batch-error]').textContent = '请先粘贴数据'; return }
      const result = this.pasteCells(input)
      if (result !== false) { applied = true; modal.close() }
      else modal.body.querySelector('[data-batch-error]').textContent = '未修改任何单元格，请检查范围和字段约束'
    }
    modal.body.querySelector('[data-grid-paste]').focus()
  }

  setSelectedNull() {
    try {
      if (!this.cellSel) throw new Error('请先选中目标字段的单元格')
      this.applyCellEdits(this._targetRows().map(row => ({ row, column: Number(this.cellSel.col), value: null })))
    } catch (error) { toast(error.message, 'warn') }
  }

  revertSelected() {
    if (this.isMutationLocked()) return
    const indices = this._targetRows().filter(index => this.rowState.get(index)?.status !== 'clean')
    if (!indices.length) return
    this._recordUndo()
    indices.forEach(index => {
      this.insertedRows = this.insertedRows.filter(row => row._idx !== index)
      this.rowState.delete(index); if (index >= this.rows.length) this.selectedRows.delete(index)
    })
    this._applyView(); this.onRevert(); this.onSelectionChange(this.selectedRows)
  }

  copyRows(format = 'tsv') {
    const values = this._targetRows().map(index => this._sortRow(index)).filter(Boolean)
    if (!values.length) { toast('请先选择行', 'warn'); return }
    const text = format === 'json' ? JSON.stringify(values.map(row => Object.fromEntries(this.columns.map((column, index) => [this._colLabel(column), row[index] ?? null]))), null, 2) : gridTsv(values)
    void clipboardWrite(text)
    toast(`已复制 ${values.length} 行`, 'success')
  }

  /* ── 视图层：排序 / 筛选 / 分页（均为客户端，模型索引不变）── */

  /** 排序比较：NULL 最小，数字/日期可比则数值比较，否则字符串本地化比较 */
  _cmpRows(ci) {
    const dir = this.sortDir === 'desc' ? -1 : 1
    const col = this.columns[ci]
    const numeric = col?.dataType ? /int|number|decimal|double|float|real|bit/i.test(col.dataType) : false
    return (a, b) => {
      const va = a[ci]
      const vb = b[ci]
      if (va === null || va === undefined) return vb === null || vb === undefined ? 0 : -dir
      if (vb === null || vb === undefined) return dir
      if (numeric || (typeof va === 'number' && typeof vb === 'number')) {
        const na = Number(va)
        const nb = Number(vb)
        if (Number.isFinite(na) && Number.isFinite(nb)) return (na - nb) * dir
      }
      return String(va).localeCompare(String(vb), 'zh-Hans-CN', { numeric: true }) * dir
    }
  }

  /** 列头三态排序：none → asc → desc → none */
  _cycleSort(ci) {
    if (this.serverPage) { const column = this.columns[ci]?.name, current = this.serverPage.order?.find((item) => item.column === column); this.onServerSort(column, !current ? 'asc' : current.direction === 'asc' ? 'desc' : null); return }
    if (this.sortCol !== ci) {
      this.sortCol = ci
      this.sortDir = 'asc'
    } else if (this.sortDir === 'asc') this.sortDir = 'desc'
    else {
      this.sortCol = null
      this.sortDir = null
    }
    this._renderHead()
    this._applyView({ resetScroll: true })
  }

  /** 单元格匹配文本（过滤用，不截断长文本） */
  _cellText(idx, ci) {
    const st = this.rowState.get(idx)
    const row = this.rows[idx]
    const raw =
      hasBufferedValues(st) ? st.current?.[ci] : row?.[ci]
    if (raw === null || raw === undefined) return 'NULL'
    if (typeof raw === 'object') return JSON.stringify(raw)
    return String(raw)
  }

  _pageCount() {
    return Math.max(1, Math.ceil(this.viewAllIdxs.length / this.pageSize))
  }

  filterLoaded(column, text) {
    if (this.serverPage) return
    this.filters = text ? { [column]: text } : {}
    this.page = 0
    this._renderHead()
    this._applyView({ resetScroll: true })
  }

  setViewOptions({ readOnly, serverPage, pageSize }) {
    this.readOnly = !!readOnly
    this.serverPage = serverPage
    this.pageSize = serverPage ? Math.max(1, this.rows.length) : Math.max(1, Number(pageSize) || 200)
    if (serverPage) this.filters = {}
    this._renderHead()
    this._applyView()
  }

  /** 过滤 + 排序 + 分页 → viewIdxs；sort/filter/page 变化后调用 */
  _applyView({ resetScroll = false } = {}) {
    const hasFilter = Object.values(this.filters).some((v) => String(v ?? '').trim() !== '')
    let idxs = [...this.rows.keys()].filter(index => !this.committedDeletedRows.has(index))
    if (hasFilter) {
      idxs = idxs.filter((i) =>
        Object.entries(this.filters).every(([ci, kw]) => {
          const q = String(kw ?? '').trim().toLowerCase()
          if (!q) return true
          return this._cellText(i, Number(ci)).toLowerCase().includes(q)
        })
      )
    }
    if (!this.serverPage && this.sortCol != null && this.sortDir) {
      const cmp = this._cmpRows(this.sortCol)
      // 排序时优先用脏值/新增值比较，保证编辑后顺序即时反映
      idxs.sort((a, b) => cmp(this._sortRow(a), this._sortRow(b)))
    }
    this.viewAllIdxs = idxs
    // 页码越界（过滤后行数变少）回退到最后一页
    if (this.page >= this._pageCount()) this.page = this._pageCount() - 1
    if (this.page < 0) this.page = 0
    const start = this.page * this.pageSize
    this.viewIdxs = idxs.slice(start, start + this.pageSize).concat(this.insertedRows.map((r) => r._idx))
    if (resetScroll) this.el.viewport.scrollTop = 0
    this._renderRows()
  }

  /** 排序比较用行数据：脏行取 current，干净行取原行 */
  _sortRow(idx) {
    const st = this.rowState.get(idx)
    if (hasBufferedValues(st) && st.current) return st.current
    return this._getRow(idx)
  }

  _renderSelbar() {
    const bar = this.el.selbar
    if (!bar) return
    const pending = this.pendingChanges()
    const dirty = pending.length > 0
    const sel = this.selectedRows.size
    const canWrite = this.editable && !this.readOnly && !this.isMutationLocked()
    const show = sel > 0 || dirty
    bar.hidden = !show
    if (!show) {
      bar.innerHTML = ''
      return
    }
    const parts = []
    if (sel) parts.push(`<span class="muted sm">${sel} 行</span>`)
    if (dirty) parts.push(`<span class="badge warn">变更 ${pending.length}</span>`)
    if (dirty && canWrite) {
      parts.push(`<button type="button" class="btn sm primary" data-sel="commit">提交</button>`)
      parts.push(`<button type="button" class="btn sm" data-sel="revert">放弃</button>`)
    }
    if (canWrite) parts.push(`<button type="button" class="btn sm" data-sel="insert">新增</button>`)
    if (canWrite && sel) parts.push(`<button type="button" class="btn sm" data-sel="batch">批量编辑</button><button type="button" class="btn sm" data-sel="delete">删除</button>`)
    if (canWrite && this.undoStack.length) parts.push(`<button type="button" class="btn sm" data-sel="undo" title="撤销上一步本地操作">撤销</button>`)
    parts.push(
      `<button type="button" class="btn icon" data-sel="more" title="更多" aria-label="更多">⋯</button>`
    )
    bar.innerHTML = parts.join('')
  }

  openOverflowMenu(event) { this.openCellContextMenu(event) }

  openCellContextMenu(event) {
    const canWrite = this.editable && !this.readOnly && !this.isMutationLocked(), indices = this._targetRows(), cell = this.cellSel
    const items = [
      ['inspect-cell', '查看内容 / JSON 树'], ['copy-cell', '复制单元格'],
      ['copy-rows', `复制 ${indices.length || ''} 行 TSV`], ['copy-row-json', '复制选中行 JSON'],
      ['copy-name', '复制字段名'], ['filter-value', this.serverPage ? '按此值筛选服务器' : '按此值筛选已加载结果'],
      'sep', ['export-selected', '导出选中行…'], ['export-page', '导出当前页…'], ['export', '导出全部已加载…']
    ]
    if (canWrite) {
      items.push('sep', ['edit', '编辑单元格'], ['batch', '批量编辑选中行…'], ['null', '将选中行此字段设为 NULL'], ['dup', '复制为新行'], ['delete', '标记删除选中行', { danger: true }], ['revert-selected', '撤销选中行修改'])
      if (this.undoStack.length) items.push(['undo', '撤销上一步本地操作'])
      if (this.redoStack.length) items.push(['redo', '重做本地操作'])
      if (this.pendingChanges().length) items.push('sep', ['commit', '提交变更'], ['revert', '放弃全部本地变更'])
      items.push('sep', ['import', '导入 CSV'])
    }
    items.push(['dml', '预览变更 SQL'], ['refresh', '刷新结果'])
    const menu = openCtxMenu(event, items, (action) => {
      if (action === 'inspect-cell' && cell) openValueInspector(this._sortRow(cell.row)?.[Number(cell.col)], this._colLabel(this.columns[Number(cell.col)]))
      else if (action === 'copy-cell') this.copyActiveCell()
      else if (action === 'copy-rows') this.copyRows()
      else if (action === 'copy-row-json') this.copyRows('json')
      else if (action === 'copy-name' && cell) void clipboardWrite(this._colLabel(this.columns[Number(cell.col)]))
      else if (action === 'filter-value' && cell) {
        const value = this._sortRow(cell.row)?.[Number(cell.col)]
        if (this.serverPage) this.onServerFilter(this._colLabel(this.columns[Number(cell.col)]), value)
        else { this.filterOpen = true; this.filterLoaded(Number(cell.col), value == null ? 'NULL' : String(value)) }
      } else if (action === 'export-selected') this.onExport('selected')
      else if (action === 'export-page') this.onExport('page')
      else if (action === 'export') this.onExport('all')
      else if (action === 'refresh') this.onRefresh()
      else if (action === 'edit' && cell) this._beginEdit(cell.row, cell.col)
      else if (action === 'batch') this.openBatchEditor()
      else if (action === 'null') this.setSelectedNull()
      else if (action === 'dup') this.duplicateRow()
      else if (action === 'delete') this.markDeleteSelected()
      else if (action === 'revert-selected') this.revertSelected()
      else if (action === 'undo') this.undoLocal()
      else if (action === 'redo') this.undoLocal(true)
      else if (action === 'commit') this.onCommit()
      else if (action === 'revert') this.revertAll()
      else if (action === 'import') this.onImport()
      else if (action === 'dml') this.onGenerateSql('preview')
    })
    const disabled = [...(!cell ? ['inspect-cell', 'copy-cell', 'copy-name', 'filter-value', 'edit', 'null'] : []), ...(!indices.length ? ['copy-rows', 'copy-row-json', 'batch', 'dup', 'delete', 'revert-selected'] : []), ...(!this.selectedRows.size ? ['export-selected'] : [])]
    disabled.forEach(action => { const button = menu.querySelector(`[data-k="${action}"]`); if (button) button.disabled = true })
  }

  sortColumn(column, direction) {
    if (this.serverPage) { this.onServerSort(this._colLabel(this.columns[column]), direction); return }
    this.sortCol = direction ? column : null; this.sortDir = direction || null
    this._renderHead(); this._applyView({ resetScroll: true })
  }

  openColumnContextMenu(event, column) {
    const label = this._colLabel(this.columns[column]), items = [['copy-name', '复制字段名'], ['copy-column', '复制此列当前页'], ['asc', '升序排列'], ['desc', '降序排列'], ['sort-clear', '取消排序']]
    if (!this.serverPage) items.push('sep', ['filter', '筛选此列已加载值'], ['filter-clear', '清除此列筛选'])
    if (this.selectedRows.size && this.editable && !this.readOnly) items.push('sep', ['batch', '批量编辑选中行的此字段…'])
    openCtxMenu(event, items, (action) => {
      if (action === 'copy-name') void clipboardWrite(label)
      else if (action === 'copy-column') void clipboardWrite(gridTsv(this.viewIdxs.map(index => [this._sortRow(index)?.[column]])))
      else if (action === 'asc' || action === 'desc') this.sortColumn(column, action)
      else if (action === 'sort-clear') this.sortColumn(column, null)
      else if (action === 'filter') { this.filterOpen = true; this._renderHead(); this.el.head.querySelector(`[data-filter-c="${column}"]`)?.focus() }
      else if (action === 'filter-clear') { delete this.filters[column]; this._renderHead(); this._applyView({ resetScroll: true }) }
      else if (action === 'batch') this.openBatchEditor(column)
    })
  }

  copyActiveCell() {
    const sel = this.cellSel
    if (!sel) {
      toast('请先选中单元格', 'warn')
      return
    }
    const row = this._getRow(sel.row)
    if (!row) return
    const ci = Number(sel.col)
    const st = this._ensureState(sel.row)
    const raw = hasBufferedValues(st) ? st.current?.[ci] : row[ci]
    const text = raw === null || raw === undefined ? 'NULL' : typeof raw === 'object' ? JSON.stringify(raw, null, 2) : String(raw)
    try {
      void clipboardWrite(text)
    } catch {
      /* ignore */
    }
    toast('已复制单元格', 'success')
  }

  copyRowJson() {
    const sel = this.cellSel
    const idx = sel?.row ?? [...this.selectedRows][0]
    if (idx == null) {
      toast('请先选中一行', 'warn')
      return
    }
    const row = this._getRow(idx)
    if (!row) return
    const st = this._ensureState(idx)
    const values = hasBufferedValues(st) ? st.current : row
    const obj = {}
    this.columns.forEach((c, i) => {
      obj[this._colLabel(c)] = values?.[i] ?? null
    })
    try {
      void clipboardWrite(JSON.stringify(obj, null, 2))
    } catch {
      /* ignore */
    }
    toast('已复制行 JSON', 'success')
  }

  discardChange(idx) {
    if (this.isMutationLocked()) return
    const st = this.rowState.get(idx)
    if (!st || st.committedInsert || this.committedDeletedRows.has(idx)) return
    this._recordUndo()
    if (st.insert || idx >= this.rows.length) {
      this.insertedRows = this.insertedRows.filter((r) => r._idx !== idx)
      this.rowState.delete(idx)
      this.selectedRows.delete(idx)
      if (this.cellSel?.row === idx) this.cellSel = null
    } else {
      st.current = st.original ? st.original.slice() : st.current
      st.status = 'clean'
      st.error = ''
      delete st.failType
    }
    this._applyView()
    this.onRevert()
  }

  setResult({ result, tableRef, readOnly, driverUpdatable, pageSize, serverPage }) {
    this._cancelEdit()
    this.serverPage = serverPage || null
    this.data = result || null
    this.columns = result?.columns || []
    this.columnWidths = {}
    this._layoutCache = null
    this.rows = Array.isArray(result?.rows) ? result.rows : []
    this.rowIdentity = result?.rowIdentity || null
    if (!this.rowIdentity?.keyColumns?.length && this.columns.length) {
      const pkIdx = []
      const keyColumns = []
      this.columns.forEach((c, i) => {
        if (c?.primaryKey || c?.pk) {
          keyColumns.push(this._colLabel(c))
          pkIdx.push(i)
        }
      })
      if (keyColumns.length) {
        this.rowIdentity = {
          keyColumns,
          keys: this.rows.map((row) => pkIdx.map((i) => row[i]))
        }
      }
    }
    this.tableRef = tableRef || result?.tableRef || null
    this.readOnly = !!readOnly
    this.driverUpdatable = !!driverUpdatable
    this.editable =
      !readOnly &&
      !!driverUpdatable &&
      result?.editable !== false &&
      !!(this.rowIdentity?.keyColumns?.length || !this.rows.length && this.tableRef) &&
      !this.readOnly
    if (result?.tableRef && !this.tableRef) this.tableRef = result.tableRef
    this.rowState.clear()
    this.insertedRows = []
    this.committedDeletedRows = new Set()
    this.selectedRows.clear()
    this.cellSel = null
    this.selectionAnchor = null
    this.undoStack = []; this.redoStack = []
    this._lastChangeIdxs = null
    // 新结果集：视图状态归零（pageSize 取传入持久化值）
    const ps = Number(pageSize)
    if (ps > 0) this.pageSize = ps
    this.sortCol = serverPage?.order?.length ? this.columns.findIndex((column) => column.name === serverPage.order[0].column) : null
    this.sortDir = serverPage?.order?.[0]?.direction || null
    if (serverPage) this.pageSize = Math.max(1, this.rows.length)
    this.filters = {}
    this.page = 0
    this.filterOpen = false
    this.el.viewport.scrollTop = 0
    this.el.viewport.scrollLeft = 0
    this._renderHead()
    this._applyView()
  }

  /** Runtime-only tab state. Results remain immutable; only editable buffers are copied. */
  captureState() {
    this._commitEdit()
    const buffers = structuredClone({ rowState: this.rowState, insertedRows: this.insertedRows, committedDeletedRows: this.committedDeletedRows })
    return {
      data: this.data, columns: this.columns, rows: this.rows, rowIdentity: this.rowIdentity,
      tableRef: this.tableRef, readOnly: this.readOnly, editable: this.editable,
      driverUpdatable: this.driverUpdatable, serverPage: structuredClone(this.serverPage || null),
      ...buffers, selectedRows: new Set(this.selectedRows), cellSel: this.cellSel ? { ...this.cellSel } : null,
      selectionAnchor: this.selectionAnchor, dialect: this.dialect,
      columnWidths: { ...this.columnWidths },
      undoStack: structuredClone(this.undoStack), redoStack: structuredClone(this.redoStack),
      sortCol: this.sortCol, sortDir: this.sortDir, filterOpen: this.filterOpen,
      filters: { ...this.filters }, page: this.page, pageSize: this.pageSize,
      lastChangeIdxs: this._lastChangeIdxs?.slice() || null,
      scrollTop: this.el.viewport.scrollTop, scrollLeft: this.el.viewport.scrollLeft, rowHeight: this.rowHeight
    }
  }

  /** Restore a retained result without setResult(), which intentionally clears pending edits. */
  restoreState(snapshot) {
    if (!snapshot) return false
    this._cancelEdit()
    const buffers = structuredClone({ rowState: snapshot.rowState, insertedRows: snapshot.insertedRows, committedDeletedRows: snapshot.committedDeletedRows || new Set() })
    for (const key of ['data', 'columns', 'rows', 'rowIdentity', 'tableRef', 'readOnly', 'editable', 'driverUpdatable', 'sortCol', 'sortDir', 'filterOpen', 'page', 'pageSize']) this[key] = snapshot[key]
    this.serverPage = structuredClone(snapshot.serverPage || null)
    this.rowState = buffers.rowState
    this.insertedRows = buffers.insertedRows
    this.committedDeletedRows = buffers.committedDeletedRows
    this.selectedRows = new Set(snapshot.selectedRows)
    this.cellSel = snapshot.cellSel ? { ...snapshot.cellSel } : null
    this.selectionAnchor = snapshot.selectionAnchor ?? null
    this.dialect = snapshot.dialect || 'mysql'
    this.columnWidths = { ...snapshot.columnWidths }
    this._layoutCache = null
    this.undoStack = structuredClone(snapshot.undoStack || []); this.redoStack = structuredClone(snapshot.redoStack || [])
    this.filters = { ...snapshot.filters }
    this._lastChangeIdxs = snapshot.lastChangeIdxs?.slice() || null
    this._renderHead()
    this._applyView()
    // Apply after the canvas receives its height, otherwise the browser clamps the old scroll offset.
    this.el.viewport.scrollTop = (snapshot.scrollTop || 0) * this.rowHeight / (snapshot.rowHeight || this.rowHeight)
    this.el.viewport.scrollLeft = snapshot.scrollLeft || 0
    this._syncHorizontalScroll()
    this._renderRows()
    this.onSelectionChange(this.selectedRows)
    return true
  }

  hasPendingChanges() {
    this._commitEdit()
    return this.pendingChanges().length > 0
  }

  setTableRef(tableRef) {
    this.tableRef = tableRef
    if (tableRef && this.rowIdentity?.keyColumns?.length) this.editable = this.driverUpdatable && this.data?.editable !== false && !this.readOnly
    this._renderBadge()
  }

  updateColumnMetadata(columns) {
    if (!Array.isArray(columns) || columns.length !== this.columns.length || columns.some((column, index) => this._colLabel(column) !== this._colLabel(this.columns[index]))) return false
    this.columns = columns
    // Metadata only changes labels; never disturb the live cell editor or its selection.
    this._renderHead()
    this.el.canvas?.querySelectorAll?.('[role=gridcell][data-c]').forEach(cell => {
      cell.classList.remove('align-text', 'align-numeric', 'align-boolean')
      cell.classList.add(`align-${columnAlignment(columns[Number(cell.dataset.c)])}`)
    })
    if (this.el.cellEditor && !this.el.cellEditor.hidden) this.el.cellEditor.dataset.alignment = columnAlignment(columns[Number(this.el.cellEditor.dataset.c)])
    return true
  }

  _renderBadge() {
    const b = this.el.badge
    if (!b) return
    if (!this.data && !this.insertedRows.length) {
      b.textContent = '—'
      b.title = ''
      b.className = 'badge'
      return
    }
    if (this.readOnly) {
      b.textContent = '只读'
      b.title = '当前连接、控制台或运行中的任务不允许修改此结果'
      b.className = 'badge warn'
      return
    }
    if (!this.editable) {
      const noKey = this.driverUpdatable && this.rows.length && !this.rowIdentity?.keyColumns?.length
      b.textContent = noKey ? '无主键 · 只读' : '只读'
      b.title = noKey ? '结果没有可靠的行主键。请从连接面板打开表数据后编辑；仅指定表名不会获得修改权限。' : '宿主或数据库驱动将此结果标记为只读'
      b.className = 'badge warn'
      return
    }
    b.textContent = '可编辑'
    b.title = '修改先保存在本地，确认提交后才写入数据库'
    b.className = 'badge ok'
  }

  _colLabel(col) {
    return col?.name ?? String(col)
  }

  _isPrimaryColumn(index) {
    const column = this.columns[index]
    return !!(column?.primaryKey || column?.pk || this.rowIdentity?.keyColumns?.includes(this._colLabel(column)))
  }

  _columnLayout() {
    const viewportWidth = this.el.viewport?.clientWidth || 0, scale = this.rowHeight / ROW_H
    const cache = this._layoutCache
    if (cache && cache.columns === this.columns && cache.rows === this.rows && cache.overrides === this.columnWidths && cache.viewportWidth === viewportWidth && cache.scale === scale) return cache.layout
    const layout = createGridLayout(this.columns, this.rows, { viewportWidth, scale, widths: this.columnWidths })
    this._layoutCache = { columns: this.columns, rows: this.rows, overrides: this.columnWidths, viewportWidth, scale, layout }
    return layout
  }

  _gridTemplate() { return this._columnLayout().template }
  _rowWidth() { return `${this._columnLayout().totalWidth}px` }

  _syncHorizontalScroll() {
    const viewport = this.el.viewport, head = this.el.head
    if (!head || !viewport) return
    head.scrollLeft = viewport.scrollLeft
    if (this.el.body) {
      this.el.body.dataset.scrollLeft = String(viewport.scrollLeft > 1)
      this.el.body.dataset.scrollRight = String(viewport.scrollLeft < viewport.scrollWidth - viewport.clientWidth - 1)
    }
  }

  _applyColumnLayout() {
    if (!this.el.canvas || !this.el.head) return
    const layout = this._columnLayout(), viewport = this.el.viewport
    this.el.head.style.width = `${viewport.clientWidth}px`
    this.el.canvas.style.width = `${layout.totalWidth}px`
    this.root.style.setProperty('--rg-selection-width', `${layout.selectionWidth}px`)
    this.root.style.setProperty('--rg-leading-width', `${layout.leadingWidth}px`)
    this.root.style.setProperty('--rg-status-width', `${layout.statusWidth}px`)
    for (const row of this.root.querySelectorAll('.grid-head > .tr, .grid-canvas > .tr')) {
      row.style.gridTemplateColumns = layout.template
      row.style.width = `${layout.totalWidth}px`
      row.style.minWidth = `${layout.totalWidth}px`
    }
    this.el.head.querySelectorAll('[data-resize-column]').forEach(handle => handle.setAttribute('aria-valuenow', Math.round(layout.widths[Number(handle.dataset.resizeColumn)])))
    this._positionCellEditor()
    this._syncHorizontalScroll()
  }

  _setColumnWidth(column, width) {
    const layout = this._columnLayout(), scale = this.rowHeight / ROW_H
    // Freeze the other displayed widths at drag start so the pointer maps 1:1 to this boundary.
    this.columnWidths = { ...Object.fromEntries(layout.widths.map((value, index) => [index, value])), [column]: Math.max(Math.round(96 * scale), Math.min(Math.round(960 * scale), Math.round(width))) }
    this._applyColumnLayout()
  }

  _fitColumn(column) {
    this._setColumnWidth(column, estimateColumnWidth(this.columns[column], this.rows.slice(0, 50).map(row => row[column]), this.rowHeight / ROW_H))
  }

  _startColumnResize(event) {
    const handle = event.target.closest('[data-resize-column]')
    if (!handle || event.button !== 0) return
    event.preventDefault(); event.stopPropagation()
    const column = Number(handle.dataset.resizeColumn), start = event.clientX, width = this._columnLayout().widths[column]
    handle.setPointerCapture(event.pointerId)
    handle.classList.add('resizing')
    const move = next => { if (next.pointerId === event.pointerId) this._setColumnWidth(column, width + next.clientX - start) }
    const finish = next => {
      if (next.pointerId !== event.pointerId) return
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish); handle.removeEventListener('lostpointercapture', finish)
      handle.classList.remove('resizing')
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish); handle.addEventListener('lostpointercapture', finish)
  }

  _positionCellEditor() {
    const editor = this.el.cellEditor
    if (!editor || editor.hidden) return
    const cell = this.el.viewport.querySelector(`[data-r="${editor.dataset.r}"][data-c="${editor.dataset.c}"]`)
    if (!cell) return
    editor.style.left = `${cell.offsetLeft}px`; editor.style.top = `${cell.offsetTop}px`
    editor.style.width = `${cell.offsetWidth}px`; editor.style.height = `${cell.offsetHeight}px`
  }

  _revealColumn(column) {
    const layout = this._columnLayout(), viewport = this.el.viewport
    const start = layout.leadingWidth + layout.widths.slice(0, column).reduce((sum, width) => sum + width, 0)
    const end = start + layout.widths[column]
    const visible = viewport.clientWidth - layout.leadingWidth - layout.statusWidth
    if (start < viewport.scrollLeft + layout.leadingWidth || layout.widths[column] > visible) viewport.scrollLeft = Math.max(0, start - layout.leadingWidth)
    else if (end > viewport.scrollLeft + viewport.clientWidth - layout.statusWidth) viewport.scrollLeft = end - viewport.clientWidth + layout.statusWidth
    this._syncHorizontalScroll()
  }

  _renderHead() {
    const cols = this.columns
    const tpl = this._gridTemplate()
    const cells = [
      '<div class="th sel"><input type="checkbox" data-act="sel-all" aria-label="选择当前页全部行" /></div>',
      '<div class="th idx">#</div>'
    ]
      .concat(
        cols.map((c, i) => {
          const pk = this._isPrimaryColumn(i) ? '<span class="pk">PK</span>' : ''
          const typeName = c?.dataType || c?.type || ''
          const type = typeName ? `<span class="col-type">${escape(typeName)}</span>` : '<span class="col-type">—</span>'
          const label = this._colLabel(c), comment = c?.comment || c?.remarks || c?.description || ''
          const sorted = this.sortCol === i && this.sortDir
          const arrow = sorted
            ? `<span class="sort-ind" style="color:var(--accent);font-size:10px">${this.sortDir === 'asc' ? '▲' : '▼'}</span>`
            : ''
          const title = [label, comment, typeName, `${this.serverPage ? '服务器排序' : '仅排序已加载结果'}（升序 → 降序 → 取消）`].filter(Boolean).join(' · ')
          return `<div class="th align-${columnAlignment(c)}${sorted ? ' sorted' : ''}" data-c="${i}" role="columnheader" tabindex="0" aria-sort="${sorted ? this.sortDir === 'asc' ? 'ascending' : 'descending' : 'none'}" title="${escape(title)}"><span class="rg-header-content"><span class="rg-column-label"><span class="rg-column-name">${escape(label)}</span>${comment ? `<span class="rg-column-comment">${escape(comment)}</span>` : ''}${arrow}</span><span class="rg-column-meta">${type}${pk}</span></span><span class="rg-column-resize" data-resize-column="${i}" role="separator" aria-orientation="vertical" tabindex="0" aria-label="调整 ${escape(label)} 列宽" aria-valuemin="${Math.round(96 * this.rowHeight / ROW_H)}" aria-valuemax="${Math.round(960 * this.rowHeight / ROW_H)}" title="拖动调整列宽；双击自动适应。方向键微调，Home 自动适应。"></span></div>`
        })
      )
      .concat('<div class="th status" title="本地行变更状态">状态</div>').join('')
    let html = `<div class="tr head-row" style="grid-template-columns:${tpl};min-width:${this._rowWidth()}">${cells}</div>`
    if (this.filterOpen && cols.length) {
      const fcells = [
        '<div class="th sel"></div>',
        '<div class="th idx">#</div>'
      ]
        .concat(
          cols.map((c, i) => {
            const v = escape(this.filters[i] ?? '')
            return `<div class="th" data-fc="${i}"><input type="text" class="rg-filter-input" data-filter-c="${i}" value="${v}" placeholder="筛选…" style="width:100%;min-width:60px;box-sizing:border-box;padding:2px 6px;font-size:11px;font-family:var(--font);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-xs);color:var(--text);outline:none" /></div>`
          })
        )
        .concat('<div class="th status"></div>').join('')
      html += `<div class="tr rg-filter-row" style="grid-template-columns:${tpl};min-width:${this._rowWidth()}">${fcells}</div>`
    }
    this.el.head.innerHTML = html
    this._applyColumnLayout()
    this.el.filterToggle.hidden = !cols.length || !!this.serverPage
    this.el.filterToggle.title = '仅筛选已加载结果'
    this.el.filterToggle.classList.toggle('active', this.filterOpen)
    this.el.filterToggle.style.color = this.filterOpen ? 'var(--accent)' : ''
    this.el.head.querySelector('[data-act=sel-all]')?.addEventListener('change', (e) => {
      // 全选作用于当前视图（排序/筛选/分页后的可见行）
      if (e.target.checked) this.viewIdxs.forEach((i) => this.selectedRows.add(i))
      else this.viewIdxs.forEach(index => this.selectedRows.delete(index))
      this._renderRows()
      this.onSelectionChange(this.selectedRows)
    })
  }

  _allRowIndices() {
    return [...this.rows.keys(), ...this.insertedRows.map((r) => r._idx)].filter(index => !this.committedDeletedRows.has(index))
  }

  _getRow(idx) {
    if (this.committedDeletedRows.has(idx)) return null
    if (idx < this.rows.length) return this.rows[idx]
    return this.insertedRows.find((r) => r._idx === idx)?.values || null
  }

  _ensureState(idx) {
    if (!this.rowState.has(idx)) {
      const original = this._getRow(idx)
      this.rowState.set(idx, {
        status: 'clean',
        original,
        current: original ? original.slice() : null,
        selected: false,
        error: '',
        key: this._keyOf(idx),
        insert: idx >= this.rows.length
      })
    }
    return this.rowState.get(idx)
  }

  _keyOf(idx) {
    const ri = this.rowIdentity
    if (!ri?.keyColumns?.length) return null
    if (idx >= this.rows.length) return null
    const keyVals = ri.keys?.[idx]
    if (keyVals) {
      if (keyVals.length < ri.keyColumns.length || ri.keyColumns.some((_, index) => keyVals[index] == null)) return null
      const key = {}
      ri.keyColumns.forEach((col, i) => {
        key[col] = keyVals[i]
      })
      return key
    }
    // 无 keys 矩阵时用列 primaryKey 从当前行取值
    const row = this.rows[idx]
    if (!row) return null
    const key = {}
    for (const name of ri.keyColumns) {
      const ci = this.columns.findIndex((c) => this._colLabel(c) === name)
      if (ci < 0 || row[ci] == null) return null
      if (ci < 0) return null
      key[name] = row[ci]
    }
    return key
  }

  _renderRows({ preserveEditor = false } = {}) {
    const editor = this.el.cellEditor
    const retainEditor = preserveEditor && editor && !editor.hidden
    const editorSelection = retainEditor ? { focused: document.activeElement === editor, start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection } : null
    if (editor && !editor.hidden && !retainEditor) this._commitEdit()
    const viewport = this.el.viewport
    const canvas = this.el.canvas
    const view = this.viewIdxs
    const total = view.length
    const scrollTop = viewport.scrollTop
    this._renderedScrollTop = scrollTop
    const h = viewport.clientHeight || 300
    this._renderedHeight = viewport.clientHeight
    const rowHeight = this.rowHeight
    const layout = this._columnLayout()
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 5)
    const end = Math.min(total, Math.ceil((scrollTop + h) / rowHeight) + 5)
    canvas.style.height = `${total * rowHeight}px`
    canvas.style.paddingTop = `${start * rowHeight}px`
    canvas.style.width = `${layout.totalWidth}px`

    const frag = document.createDocumentFragment()
    for (let vi = start; vi < end; vi++) {
      const i = view[vi]
      const row = this._getRow(i)
      if (!row) continue
      const st = this._ensureState(i)
      const tr = document.createElement('div')
      tr.className = `tr row-${st.status}${vi % 2 ? ' row-alt' : ''}${this.selectedRows.has(i) ? ' selected' : ''}`
      tr.dataset.row = i
      tr.setAttribute('role', 'row')
      tr.setAttribute('aria-selected', String(this.selectedRows.has(i)))
      tr.style.height = `${rowHeight}px`
      tr.style.gridTemplateColumns = layout.template
      tr.style.width = `${layout.totalWidth}px`
      tr.style.minWidth = `${layout.totalWidth}px`
      const checked = this.selectedRows.has(i) ? 'checked' : ''
      // 行号与分页栏「from-to」同语义：全局连续（含过滤/排序后的视图顺序），插入行接续编号
      const rowNo = this.page * this.pageSize + vi + 1
      let html = `<div class="td sel"><input type="checkbox" class="row-check" aria-label="选择第 ${rowNo} 行" ${checked} /></div><div class="td idx">${rowNo}</div>`
      this.columns.forEach((col, ci) => {
        const raw = row[ci]
        const cur = hasBufferedValues(st) ? st.current?.[ci] : raw
        const dirtyCell = hasBufferedValues(st) && !st.insert && st.original?.[ci] !== st.current?.[ci]
        const isNull = cur === null || cur === undefined
        const cls = [
          'td',
          `align-${columnAlignment(col)}`,
          this._isPrimaryColumn(ci) ? 'pk-cell' : '',
          isNull ? 'null-cell' : '',
          dirtyCell ? 'dirty-cell' : '',
          this.cellSel?.row === i && String(this.cellSel?.col) === String(ci) ? 'cell-active' : ''
        ]
          .filter(Boolean)
          .join(' ')
        const text = isNull ? 'NULL' : formatCell(cur)
        html += `<div class="${cls}" role="gridcell" data-r="${i}" data-c="${ci}" title="${escape(text)}"><span class="rg-cell-text">${escape(text)}</span></div>`
      })
      const statusText = st.committedInsert ? '已写入·待刷新' :
        st.status === 'clean'
          ? ''
          : st.status === 'dirty'
            ? '已修改'
            : st.status === 'inserted'
              ? '新增'
              : st.status === 'deleted'
                ? '删除'
                : st.status === 'failed'
                  ? '失败'
                  : st.status
      html += `<div class="td status ${st.status}" title="${st.committedInsert ? '此行已写入；请刷新以读取数据库默认值和生成主键' : statusText}">${statusText}${
        st.error ? `<span class="err" title="${escape(st.error)}">!</span>` : ''
      }</div>`
      tr.innerHTML = html
      frag.appendChild(tr)
    }
    // A window/pane resize may require more virtual rows; retain the live input,
    // selection and focus while moving its DOM node across the row refresh.
    this._movingEditor = retainEditor
    if (retainEditor) frag.appendChild(editor)
    canvas.replaceChildren(frag)
    if (retainEditor) {
      this._positionCellEditor()
      if (editorSelection.focused) editor.focus({ preventScroll: true })
      editor.setSelectionRange(editorSelection.start, editorSelection.end, editorSelection.direction)
    }
    this._movingEditor = false
    this._syncHorizontalScroll()
    const selectAll = this.el.head.querySelector('[data-act=sel-all]')
    if (selectAll) { selectAll.checked = !!view.length && view.every(index => this.selectedRows.has(index)); selectAll.indeterminate = !selectAll.checked && view.some(index => this.selectedRows.has(index)) }
    this._renderPager()
    this._renderStatus()
    this._renderBadge()
    this._renderSelbar()
  }

  /** 底部分页条：客户端分页（宿主 db.execute 无 offset 能力） */
  _renderPager() {
    if (this.serverPage) { this.el.pager.hidden = true; return }
    const pager = this.el.pager
    if (!pager) return
    const total = this.viewAllIdxs.length
    if (!this.columns.length || !this.rows.length) {
      pager.hidden = true
      pager.style.display = ''
      pager.dataset.sig = ''
      return
    }
    pager.hidden = false
    pager.style.display = 'flex'
    const pages = this._pageCount()
    const page = Math.min(this.page, pages - 1)
    const sizes = [50, 100, 200, 500]
    if (!sizes.includes(this.pageSize)) sizes.unshift(this.pageSize)
    const from = total ? page * this.pageSize + 1 : 0
    const to = Math.min(total, (page + 1) * this.pageSize)
    // 滚动也会触发 _renderRows：内容未变时跳过重建，避免 select 交互被打断
    const confirmedInserts = this.insertedRows.filter(row => this.rowState.get(row._idx)?.committedInsert).length
    const sig = `${from}-${to}/${total}/${pages}/${this.pageSize}/${confirmedInserts}`
    if (pager.dataset.sig === sig) return
    pager.dataset.sig = sig
    pager.innerHTML = `
      <span class="muted sm" data-loaded-range>${from}–${to} / ${total} 行 · 已加载分页${total !== this.rows.length ? `（原 ${this.rows.length} 行）` : ''}${confirmedInserts ? ` · 另有 ${confirmedInserts} 行已写入待刷新` : ''}</span>
      <button type="button" class="btn sm" data-pager="prev" aria-label="已加载结果上一页" ${page <= 0 ? 'disabled' : ''}>‹</button>
      <span class="muted sm">${page + 1} / ${pages}</span>
      <button type="button" class="btn sm" data-pager="next" aria-label="已加载结果下一页" ${page >= pages - 1 ? 'disabled' : ''}>›</button>
      <select data-pager-select="size" title="每页行数">
        ${sizes.map((s) => `<option value="${s}" ${s === this.pageSize ? 'selected' : ''}>${s} 行/页</option>`).join('')}
      </select>
    `
    enhanceSelect(pager.querySelector('[data-pager-select=size]'))
  }

  _renderStatus() {
    const data = this.data
    const parts = []
    if (data) {
      const filtered = this.viewAllIdxs.length
      const total = this.rows.length - this.committedDeletedRows.size
      // 行数：过滤/排序生效时展示 过滤后/总数
      parts.push(
        filtered === total ? `${total} 行` : `行 ${filtered}/${total}`
      )
      if (data.affectedRows != null) parts.push(`影响 ${data.affectedRows}`)
      if (data.durationMs != null) parts.push(`${data.durationMs} ms`)
      // 达到 maxRows 截断时提示（宿主 QueryResult.truncated）
      if (data.truncated) parts.push('已达行数上限，结果可能被截断')
      const confirmedInserts = this.insertedRows.filter(row => this.rowState.get(row._idx)?.committedInsert).length
      if (confirmedInserts) parts.push(`${confirmedInserts} 行已写入，刷新获取生成值`)
    }
    if (this.tableRef) {
      parts.push(
        `表 ${[this.tableRef.database, this.tableRef.schema, this.tableRef.table].filter(Boolean).join('.')}`
      )
    }
    this.el.status.textContent = parts.join(' · ')
  }

  _beginEdit(rowIdx, colIdx) {
    rowIdx = Number(rowIdx); colIdx = Number(colIdx)
    const problem = this._cellProblem(rowIdx, colIdx)
    if (problem) { toast(problem, 'warn'); return }
    const st = this._ensureState(rowIdx)
    if (st.status === 'deleted') return
    const cell = this.el.viewport.querySelector(`[data-r="${rowIdx}"][data-c="${colIdx}"]`)
    if (!cell) return
    const ci = Number(colIdx)
    this._revealColumn(ci)
    const val = st.current?.[ci]
    const ed = this.el.cellEditor
    ed.hidden = false
    ed.value = val === null || val === undefined ? '' : String(val)
    ed.dataset.r = rowIdx
    ed.dataset.c = ci
    ed.dataset.alignment = columnAlignment(this.columns[ci])
    ed.setAttribute('aria-label', `编辑 ${this._colLabel(this.columns[ci])}`)
    this.el.canvas.appendChild(ed)
    this._positionCellEditor()
    ed.focus({ preventScroll: true })
    ed.select()
    this._editOriginalNull = val === null || val === undefined
  }

  _commitEdit() {
    const ed = this.el.cellEditor
    if (ed.hidden) return
    const rowIdx = Number(ed.dataset.r)
    const ci = Number(ed.dataset.c)
    let value = ed.value
    if (value === '' && this._editOriginalNull) value = null
    ed.hidden = true
    try { this._applyCell(rowIdx, ci, coerceGridValue(value, this.columns[ci])) }
    catch (error) { toast(error.message, 'warn') }
    this._applyView()
    this.onSelectionChange(this.selectedRows)
  }

  _cancelEdit() {
    this.el.cellEditor.hidden = true
  }

  _applyCell(rowIdx, ci, value, record = true) {
    const problem = this._cellProblem(rowIdx, ci, value)
    if (problem) { if (record) toast(problem, 'warn'); return false }
    const st = this._ensureState(rowIdx)
    if (!st.current) st.current = st.original ? st.original.slice() : this.columns.map(() => null)
    const prev = st.current[ci]
    if (prev === value) return false
    if (record) this._recordUndo()
    st.current[ci] = value
    if (st.insert) st.status = 'inserted'
    else if (st.original?.[ci] === value) {
      const dirty = st.current.some((v, i) => v !== st.original[i])
      st.status = dirty ? 'dirty' : 'clean'
    } else st.status = 'dirty'
    st.error = ''; delete st.failType
    return true
  }

  insertRow(fromIdx, record = true) {
    this._commitEdit()
    if (this.readOnly || !this.editable || this.isMutationLocked()) {
      toast('当前结果集不可写', 'warn')
      return
    }
    const cols = this.columns
    let values = cols.map(() => null)
    if (fromIdx != null) {
      const src = this._sortRow(fromIdx)
      if (src) values = src.map((value, column) => { const col = cols[column]; return this._isPrimaryColumn(column) || col.autoIncrement || col.generated || col.autoGenerated ? null : structuredClone(value) })
    }
    if (record) this._recordUndo()
    const idx = Math.max(this.rows.length - 1, ...this.insertedRows.map(row => row._idx)) + 1
    this.insertedRows.push({ _idx: idx, values })
    this._ensureState(idx)
    const st = this.rowState.get(idx)
    st.status = 'inserted'
    st.current = values
    st.insert = true
    // 新增行永远追加在当前页尾部可见
    this.viewIdxs = this.viewIdxs.concat([idx])
    this.el.viewport.scrollTop = this.el.viewport.scrollHeight
    this._renderRows()
    return idx
  }

  duplicateRow() {
    this._commitEdit()
    const indices = this._targetRows()
    if (!indices.length) {
      toast('请先选中一行', 'warn')
      return
    }
    if (this.readOnly || !this.editable || this.isMutationLocked()) { toast('当前结果集不可写', 'warn'); return }
    this._recordUndo()
    const added = indices.map(index => this.insertRow(index, false)).filter(index => index != null)
    this.selectedRows = new Set(added)
    this._renderRows(); this.onSelectionChange(this.selectedRows)
    toast(`已复制 ${added.length} 行，主键已留空，等待填写或由数据库生成`, 'info')
  }

  markDeleteSelected() {
    this._commitEdit()
    const indices = new Set(this._targetRows())
    if (!indices.size) {
      toast('请先选中要删除的行', 'warn')
      return
    }
    const problem = [...indices].map(index => this._rowProblem(index)).find(Boolean)
    if (problem) { toast(problem, 'warn'); return }
    this._recordUndo()
    for (const i of indices) {
      const st = this._ensureState(i)
      if (st.insert) {
        this.insertedRows = this.insertedRows.filter((r) => r._idx !== i)
        this.rowState.delete(i)
        continue
      }
      st.status = 'deleted'; st.error = ''; delete st.failType
    }
    this.selectedRows.clear()
    this._applyView()
  }

  revertAll() {
    if (this.isMutationLocked()) return
    this._cancelEdit()
    if (this.pendingChanges().length) this._recordUndo()
    this.rowState = new Map([...this.rowState].filter(([, state]) => state.committedInsert))
    this.insertedRows = this.insertedRows.filter(row => this.rowState.get(row._idx)?.committedInsert)
    this.selectedRows.clear()
    this.cellSel = null
    this._applyView()
    toast('已放弃本地变更', 'info')
    this.onRevert()
  }

  pendingChanges() {
    const out = []
    for (const [idx, st] of this.rowState) {
      if (st.status === 'clean') continue
      if (!st.status) continue
      out.push({ idx, ...st })
    }
    return out
  }

  toRowChanges() {
    const table = this._tableRefForChange()
    if (!table) return []
    const cols = this.columns.map((c) => this._colLabel(c))
    const changes = []
    for (const [idx, st] of this.rowState) {
      const kind =
        st.status === 'failed'
          ? st.failType || (st.insert ? 'inserted' : 'dirty')
          : st.status
      if (kind === 'clean') continue
      if (kind === 'dirty') {
        const set = {}
        const original = {}
        cols.forEach((name, i) => {
          original[name] = st.original?.[i]
          if (st.current?.[i] !== st.original?.[i]) set[name] = st.current?.[i]
        })
        if (!Object.keys(set).length) continue
        const key = st.key || this._keyOf(idx)
        if (!key) {
          toast('无主键，无法提交修改', 'error')
          continue
        }
        changes.push({ type: 'update', table, key, set, original, _idx: idx })
      } else if (kind === 'inserted') {
        const values = {}
        cols.forEach((name, i) => {
          const v = st.current?.[i]
          if (v !== null && v !== undefined) values[name] = v
        })
        changes.push({ type: 'insert', table, values, _idx: idx })
      } else if (kind === 'deleted') {
        const key = st.key || this._keyOf(idx)
        if (!key) {
          toast('无主键，无法提交删除', 'error')
          continue
        }
        changes.push({ type: 'delete', table, key, _idx: idx })
      }
    }
    this._lastChangeIdxs = changes.map((c) => c._idx)
    return changes
  }

  _tableRefForChange() {
    if (this.tableRef) return this.tableRef
    if (this.data?.tableRef) return this.data.tableRef
    return null
  }

  /**
   * @param batchResult 宿主 BatchResult
   * @param changes 本次提交的 RowChange[]（含 _idx），用于 index → 本地行映射
   */
  applyBatchResult(batchResult, changes) {
    const list = Array.isArray(changes) && changes.length ? changes : this.toRowChanges()
    const result = applyBatchToBuffer(this, batchResult, list)
    this.undoStack = []; this.redoStack = []
    this._applyView()
    return result
  }

  applyBatchResultToState(snapshot, batchResult, changes = []) {
    if (!snapshot) return { snapshot, anyFail: false, results: [] }
    const buffers = structuredClone({ rowState: snapshot.rowState, insertedRows: snapshot.insertedRows, committedDeletedRows: snapshot.committedDeletedRows || new Set() })
    const next = { ...snapshot, ...buffers, selectedRows: new Set(snapshot.selectedRows), cellSel: snapshot.cellSel ? { ...snapshot.cellSel } : null, undoStack: [], redoStack: [] }
    const result = applyBatchToBuffer(next, batchResult, changes)
    return { snapshot: next, ...result }
  }

  sqlPreview(changes) {
    const table = this._tableRefForChange()
    if (!table) return '-- 缺少表引用'
    const quote = value => quoteGridIdentifier(value, this.dialect)
    const t = [table.database, table.schema, table.table].filter(Boolean).map(quote).join('.')
    return (changes || this.toRowChanges())
      .map((c) => {
        if (c.type === 'update') {
          const sets = Object.entries(c.set)
            .map(([k, v]) => `${quote(k)} = ${sqlLiteral(v)}`)
            .join(', ')
          const wh = Object.entries(c.key)
            .map(([k, v]) => `${quote(k)} = ${sqlLiteral(v)}`)
            .join(' AND ')
          return `UPDATE ${t} SET ${sets} WHERE ${wh};`
        }
        if (c.type === 'insert') {
          const keys = Object.keys(c.values)
          return `INSERT INTO ${t} (${keys.map(quote).join(', ')}) VALUES (${keys
            .map((k) => sqlLiteral(c.values[k]))
            .join(', ')});`
        }
        if (c.type === 'delete') {
          const wh = Object.entries(c.key)
            .map(([k, v]) => `${quote(k)} = ${sqlLiteral(v)}`)
            .join(' AND ')
          return `DELETE FROM ${t} WHERE ${wh};`
        }
        return `-- ${c.type}`
      })
      .join('\n')
  }

  getExportData(scope = 'all', { includePending = true } = {}) {
    const cols = this.columns.map((c) => this._colLabel(c))
    this._commitEdit()
    const indices = scope === 'selected' ? [...this.selectedRows] : scope === 'page' ? this.viewIdxs : [...this.viewAllIdxs, ...this.insertedRows.map(row => row._idx)]
    const rows = indices.filter(index => {
      const state = this.rowState.get(index)
      return !this.committedDeletedRows.has(index) && state?.status !== 'deleted' && !(state?.status === 'failed' && state.failType === 'deleted') && (includePending || index < this.rows.length || state?.committedInsert)
    }).map(index => includePending ? this._sortRow(index) : this._getRow(index)).filter(Boolean).map(row => row.slice())
    return { cols, rows }
  }
}

function formatCell(v) {
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function quoteIdent(name) {
  if (!name) return ''
  return '`' + String(name).replace(/`/g, '``') + '`'
}

export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return `'${String(v).replace(/'/g, "''")}'`
}

export { ROW_H, uid }
