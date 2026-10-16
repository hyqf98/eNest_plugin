import './register-db-alias.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

// Exercise the real grid state transitions with rendering detached from the browser.
globalThis.window = { addEventListener() {}, enest: { ui: { toast: async () => {} } } }
globalThis.document = { addEventListener() {} }
const { ResultGrid } = await import('../../plugins/database/src/js/resultGrid.js')
const { SqlEditor } = await import('../../plugins/database/src/js/monacoEditor.js')
delete globalThis.window
delete globalThis.document

class StateGrid extends ResultGrid {
  _build() {
    this.el = { viewport: { scrollTop: 0, scrollLeft: 0, scrollHeight: 1000 }, cellEditor: { hidden: true, value: '', dataset: {} } }
    this.renderCount = 0
  }
  _bind() {}
  _renderHead() {}
  _renderRows() { this.renderCount++ }
}

function resultRows() {
  return {
    columns: [{ name: 'id', dataType: 'integer', primaryKey: true }, { name: 'name', dataType: 'text' }],
    rows: Array.from({ length: 12 }, (_, index) => [index + 1, `row-${index + 1}`]),
    rowIdentity: { keyColumns: ['id'], keys: Array.from({ length: 12 }, (_, index) => [index + 1]) },
    editable: true
  }
}

function gridWithResult() {
  const grid = new StateGrid({})
  grid.setResult({ result: resultRows(), tableRef: { database: 'workspace', table: 'people' }, driverUpdatable: true, pageSize: 3 })
  return grid
}

test('switching results commits the open cell and retains each tab edit buffer, view and selection', () => {
  const grid = gridWithResult()
  grid.el.cellEditor = { hidden: false, value: 'edited before switching', dataset: { r: '0', c: '1' } }
  grid._editOriginalNull = false
  grid.selectedRows.add(2)
  grid.cellSel = { row: 2, col: '1' }
  grid.markDeleteSelected()
  grid.insertRow()
  grid._applyCell(12, 1, 'new row')
  grid.selectedRows = new Set([0, 12])
  grid.cellSel = { row: 0, col: '1' }
  grid.sortCol = 0
  grid.sortDir = 'desc'
  grid.filters = { 1: 'row' }
  grid.filterOpen = true
  grid.page = 1
  grid.el.viewport.scrollTop = 28
  grid.el.viewport.scrollLeft = 90
  const first = grid.captureState()
  const changes = grid.toRowChanges()
  assert.equal(first.rowState.get(0).current[1], 'edited before switching')
  assert.deepEqual(changes.map(change => change.type).sort(), ['delete', 'insert', 'update'])
  assert.equal(grid.el.cellEditor.hidden, true)

  grid.setResult({ result: { columns: [{ name: 'other' }], rows: [['unrelated']] }, readOnly: true })
  const second = grid.captureState()
  grid.setResult = () => assert.fail('restoring must not clear the pending buffer with setResult')
  assert.equal(grid.restoreState(first), true)
  assert.equal(grid.driverUpdatable, true)
  assert.equal(grid.readOnly, false)
  assert.equal(grid.editable, true)
  assert.deepEqual(grid.toRowChanges(), changes)
  assert.deepEqual(grid.selectedRows, new Set([0, 12]))
  assert.deepEqual(grid.cellSel, { row: 0, col: '1' })
  assert.equal(grid.sortDir, 'desc')
  assert.equal(grid.filterOpen, true)
  assert.deepEqual(grid.filters, { 1: 'row' })
  assert.equal(grid.page, 1)
  assert.equal(grid.pageSize, 3)
  assert.equal(grid.el.viewport.scrollTop, 28)
  assert.equal(grid.el.viewport.scrollLeft, 90)
  assert.equal(grid.hasPendingChanges(), true)
  grid._applyCell(0, 1, 'later change')
  assert.equal(first.rowState.get(0).current[1], 'edited before switching')
  grid.restoreState(second)
  assert.equal(grid.readOnly, true)
  assert.equal(grid.hasPendingChanges(), false)
  assert.deepEqual(grid.rows, [['unrelated']])
})

test('server paging and failed edits survive snapshots without sharing mutable buffers', () => {
  const grid = gridWithResult()
  grid.serverPage = { offset: 200, limit: 200, order: [{ column: 'id', direction: 'desc' }], filters: [{ column: 'name', operator: 'contains', value: 'row' }] }
  grid._applyCell(1, 1, 'pending')
  const changes = grid.toRowChanges()
  grid.applyBatchResult({ results: [{ index: 0, ok: false, error: 'row changed remotely' }] }, changes)
  const snapshot = grid.captureState()
  grid.serverPage.filters[0].value = 'other tab'
  grid.rowState.get(1).error = 'another error'
  grid.restoreState(snapshot)
  assert.equal(grid.serverPage.offset, 200)
  assert.equal(grid.serverPage.filters[0].value, 'row')
  assert.equal(grid.rowState.get(1).status, 'failed')
  assert.equal(grid.rowState.get(1).error, 'row changed remotely')
  assert.equal(grid._cellText(1, 1), 'pending')
  assert.equal(grid._sortRow(1)[1], 'pending')
  assert.deepEqual(grid.toRowChanges(), changes)
})

test('delayed batch completion updates only its source snapshot while another result is active', () => {
  const grid = gridWithResult()
  grid._applyCell(0, 1, 'committed source value')
  grid._applyCell(1, 1, 'conflicting value')
  const changes = grid.toRowChanges()
  const source = grid.captureState()
  grid.setResult({ result: { columns: [{ name: 'other' }], rows: [['visible other tab']] }, readOnly: true })
  const visible = grid.captureState(), renders = grid.renderCount
  const completed = grid.applyBatchResultToState(source, { results: [{ index: 0, ok: true }, { index: 1, ok: false, error: 'conflict' }] }, changes)
  assert.equal(completed.anyFail, true)
  assert.equal(grid.renderCount, renders)
  assert.deepEqual(grid.captureState(), visible)
  assert.equal(source.rowState.get(0).status, 'dirty')
  assert.equal(source.rows[0][1], 'row-1')
  grid.restoreState(completed.snapshot)
  assert.equal(grid.rows[0][1], 'committed source value')
  assert.equal(grid.rowState.get(0).status, 'clean')
  assert.equal(grid.rowState.get(1).error, 'conflict')
  assert.deepEqual(grid.toRowChanges().map(change => change._idx), [1])
})

test('hasPendingChanges includes a typed cell that has not blurred', () => {
  const grid = gridWithResult()
  grid.el.cellEditor = { hidden: false, value: '42', dataset: { r: '0', c: '0' } }
  assert.equal(grid.hasPendingChanges(), true)
  assert.equal(grid.toRowChanges()[0].set.id, 42)
})

test('row height changes retain the visible row anchor, including snapshots captured at a different font size', () => {
  const grid = gridWithResult()
  grid.el.viewport.scrollTop = 56
  const snapshot = grid.captureState()
  grid._setRowHeight(42)
  assert.equal(grid.rowHeight, 42)
  assert.equal(grid.el.viewport.scrollTop, 84)
  grid.el.viewport.scrollTop = 0
  grid.restoreState(snapshot)
  assert.equal(grid.rowHeight, 42)
  assert.equal(grid.el.viewport.scrollTop, 84)
  grid._setRowHeight(0)
  assert.equal(grid.rowHeight, 42)
})

test('closing one Monaco document releases only that model and its retained view state', () => {
  const editor = Object.create(SqlEditor.prototype), events = []
  const first = { dispose: () => events.push('dispose:first') }
  const second = { dispose: () => events.push('dispose:second'), undoStack: ['SELECT 1', 'SELECT 2'] }
  editor.models = new Map([['first', first], ['second', second]])
  editor.viewStates = new Map([['first', { cursor: 1 }], ['second', { cursor: 8 }]])
  editor.instance = { getModel: () => first, setModel: value => events.push(['model', value]) }
  editor.releaseDocument('first')
  editor.releaseDocument('first')
  assert.deepEqual(events, [['model', null], 'dispose:first'])
  assert.equal(editor.models.has('first'), false)
  assert.equal(editor.viewStates.has('first'), false)
  assert.equal(editor.models.get('second'), second)
  assert.deepEqual(second.undoStack, ['SELECT 1', 'SELECT 2'])
  assert.deepEqual(editor.viewStates.get('second'), { cursor: 8 })
})

test('refreshing an active CRLF Monaco model does not replace it from the normalized textarea mirror', () => {
  const editor = Object.create(SqlEditor.prototype), edits = []
  let value = 'SELECT 中文;\r\nSELECT 2;'
  const model = { getValue: () => value, pushStackElement() { edits.push('undo-stop') }, getFullModelRange: () => ({}), pushEditOperations(_selection, operations) { edits.push(...operations); value = operations[0].text } }
  editor.documentId = 'retained'; editor.models = new Map([['retained', model]])
  editor.el = { ta: { value: value.replaceAll('\r\n', '\n') } }
  editor.instance = { getModel: () => model }
  editor.monaco = { editor: { setModelLanguage() {} } }; editor.getDialect = () => 'mysql'
  editor.updateCompletionOptions = () => {}; editor.scheduleDiagnostics = () => {}
  editor.activateModel(); editor.activateModel()
  assert.deepEqual(edits, [])
  assert.equal(value, 'SELECT 中文;\r\nSELECT 2;')
  editor.activateModel('SELECT 3;\r\nSELECT 中文;')
  assert.equal(value, 'SELECT 3;\r\nSELECT 中文;')
  assert.equal(edits.filter(edit => typeof edit === 'object').length, 1)
})
