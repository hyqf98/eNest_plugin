import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGridTsv, gridTsv, coerceGridValue } from '../../plugins/database/src/js/gridProductivity.js'

globalThis.window = { addEventListener() {}, enest: { ui: { toast: async () => {} }, clipboard: { writeText: async () => true } } }
globalThis.document = { addEventListener() {} }
const { ResultGrid } = await import('../../plugins/database/src/js/resultGrid.js')
delete globalThis.window; delete globalThis.document

class BufferGrid extends ResultGrid {
  _build() { this.el = { viewport: { scrollTop: 0, scrollLeft: 0, scrollHeight: 1000 }, cellEditor: { hidden: true, dataset: {}, value: '' } } }
  _bind() {}
  _renderHead() {}
  _renderRows() {}
  _renderBadge() {}
}
const columns = [{ name: 'id', type: 'INTEGER', primaryKey: true }, { name: 'name', type: 'TEXT' }, { name: 'enabled', type: 'BOOLEAN', nullable: false }]
function makeGrid(options = {}) {
  const grid = new BufferGrid({}, options)
  grid.setResult({ result: { columns, rows: [[1, 'first', true], [2, 'second', false], [3, 'third', true]], editable: true }, tableRef: { database: 'db', schema: 'public', table: 'people' }, driverUpdatable: true, pageSize: 2 })
  return grid
}

test('TSV round-trips quotes, empty cells and embedded line breaks without interpreting NULL text', () => {
  const values = [['quoted "text"', 'line\nnext', ''], ['NULL', '\t', 'last']]
  assert.deepEqual(parseGridTsv(gridTsv(values) + '\r\n'), values)
  assert.throws(() => parseGridTsv('a\tb\nc'), /相同列数/)
  assert.throws(() => parseGridTsv('"unclosed'), /引号/)
  assert.throws(() => parseGridTsv('a\tb', 1), /不能超过/)
  assert.throws(() => parseGridTsv('a'.repeat(1024 * 1024 + 1)), /1 MB/)
})

test('clipboard conversion preserves numeric precision and validates typed boolean/JSON values', () => {
  assert.equal(coerceGridValue('42', { type: 'int' }), 42)
  assert.equal(coerceGridValue('9007199254740993', { type: 'bigint' }), '9007199254740993')
  assert.equal(coerceGridValue('123456789.000000001', { type: 'decimal' }), '123456789.000000001')
  assert.equal(coerceGridValue('false', { type: 'boolean' }), false)
  assert.throws(() => coerceGridValue('yes', { type: 'boolean', name: 'enabled' }), /true/)
  assert.deepEqual(coerceGridValue('{"x":1}', { type: 'json' }), { x: 1 })
  assert.equal(coerceGridValue('NULL', { type: 'text' }), 'NULL')
})

test('multi-cell edits preflight every target atomically and require row identity', () => {
  const grid = makeGrid()
  assert.throws(() => grid.applyCellEdits([{ row: 0, column: 1, value: 'valid' }, { row: 1, column: 2, value: null }]), /不能设为 NULL/)
  assert.equal(grid.pendingChanges().length, 0)
  assert.equal(grid.undoStack.length, 0)
  grid.rowIdentity = null; grid.columns = columns.map(column => ({ ...column, primaryKey: false }))
  assert.throws(() => grid.applyCellEdits([{ row: 0, column: 1, value: 'unsafe' }]), /没有主键/)
  assert.equal(grid.pendingChanges().length, 0)
  grid.setTableRef({ table: 'people' })
  assert.equal(grid._applyCell(0, 1, 'still unsafe'), false)
})

test('paste uses the visible sorted page, rejects bounds and supports one-step undo and redo', () => {
  const grid = makeGrid()
  grid.sortColumn(0, 'desc')
  grid.cellSel = { row: 2, col: '1' }
  assert.equal(grid.pasteCells('updated third\tfalse\nupdated second\ttrue'), 4)
  assert.equal(grid.rowState.get(2).current[1], 'updated third')
  assert.equal(grid.rowState.get(1).current[1], 'updated second')
  assert.equal(grid.rowState.get(0), undefined)
  assert.equal(grid.undoStack.length, 1)
  assert.equal(grid.undoLocal(), true)
  assert.equal(grid.pendingChanges().length, 0)
  assert.equal(grid.undoLocal(true), true)
  assert.equal(grid.toRowChanges().length, 2)
  const before = grid.captureState()
  assert.equal(grid.pasteCells('a\tb\nc\td\ne\tf'), false)
  assert.deepEqual(grid.captureState(), before)
})

test('read-only, generated columns and in-flight tasks block all local write paths', () => {
  let locked = false
  const grid = makeGrid({ isMutationLocked: () => locked })
  grid.selectedRows.add(0)
  grid.readOnly = true
  grid.markDeleteSelected(); grid.insertRow(); grid.duplicateRow()
  assert.equal(grid.pendingChanges().length, 0)
  grid.readOnly = false; locked = true
  assert.equal(grid._applyCell(0, 1, 'locked'), false)
  grid.markDeleteSelected()
  assert.equal(grid.pendingChanges().length, 0)
  locked = false
  grid.columns = grid.columns.map((column, index) => index === 1 ? { ...column, generated: true } : column)
  assert.throws(() => grid.applyCellEdits([{ row: 0, column: 1, value: 'generated' }]), /自动生成/)
})

test('duplicating all selected rows uses pending values and clears primary keys without index reuse', () => {
  const grid = makeGrid()
  grid.applyCellEdits([{ row: 0, column: 1, value: 'pending name' }])
  grid.selectedRows = new Set([0, 1])
  grid.duplicateSelectedRows()
  assert.deepEqual(grid.insertedRows.map(row => row.values.slice(0, 2)), [[null, 'pending name'], [null, 'second']])
  const [first, second] = grid.insertedRows.map(row => row._idx)
  grid.discardChange(first)
  const third = grid.insertRow()
  assert.notEqual(third, second)
  assert.equal(new Set(grid.insertedRows.map(row => row._idx)).size, 2)
})

test('selected/page exports include buffered values, exclude deleted rows and never fall back to all', () => {
  const grid = makeGrid()
  grid.applyCellEdits([{ row: 0, column: 1, value: 'local name' }])
  assert.deepEqual(grid.getExportData('selected').rows, [])
  assert.equal(grid.getExportData('page').rows.length, 2)
  grid.selectedRows = new Set([0, 1]); grid.cellSel = { row: 2, col: '1' }
  assert.deepEqual(grid.getExportData('selected').rows.map(row => row[1]), ['local name', 'second'])
  assert.equal(grid.getExportData('selected', { includePending: false }).rows[0][1], 'first')
  grid.selectedRows = new Set([1]); grid.markDeleteSelected()
  assert.equal(grid.rowState.get(2), undefined, 'an unrelated active cell must not join the selected delete')
  assert.deepEqual(grid.getExportData().rows.map(row => row[0]), [1, 3])
})

test('reverting selected rows keeps other edits and undo history belongs to its snapshot', () => {
  const grid = makeGrid()
  grid.applyCellEdits([{ row: 0, column: 1, value: 'one' }, { row: 1, column: 1, value: 'two' }])
  grid.selectedRows = new Set([0]); grid.revertSelectedRows()
  assert.deepEqual(grid.toRowChanges().map(change => change._idx), [1])
  const source = grid.captureState()
  grid.setResult({ result: { columns, rows: [[9, 'other', true]] }, tableRef: { table: 'other' }, driverUpdatable: true })
  assert.equal(grid.undoLocal(), false)
  grid.restoreState(source); grid.undoLocal()
  assert.deepEqual(grid.toRowChanges().map(change => change._idx), [0, 1])
})

test('column metadata refresh leaves an in-progress editor and selection untouched; table targets do not elevate capabilities', () => {
  const grid = makeGrid()
  grid.el.cellEditor = { hidden: false, value: 'typed', selectionStart: 1, selectionEnd: 4, dataset: { r: '0', c: '1' } }
  grid._editOriginalNull = false; grid.selectedRows.add(1); grid.el.viewport.scrollTop = 28
  assert.equal(grid.updateColumnMetadata(columns.map(column => ({ ...column, comment: '说明' }))), true)
  assert.equal(grid.el.cellEditor.hidden, false)
  assert.equal(grid.el.cellEditor.value, 'typed')
  assert.equal(grid.el.cellEditor.selectionStart, 1)
  assert.equal(grid.el.cellEditor.selectionEnd, 4)
  assert.equal(grid.pendingChanges().length, 0)
  assert.deepEqual(grid.selectedRows, new Set([1]))
  assert.equal(grid.el.viewport.scrollTop, 28)
  assert.equal(grid.updateColumnMetadata([{ name: 'wrong' }]), false)
  grid.driverUpdatable = false; grid.setTableRef({ table: 'people' })
  assert.equal(grid.editable, false)
})

test('SQL preview quotes qualified identifiers by segment and selected dialect', () => {
  const grid = makeGrid()
  grid._applyCell(0, 1, 'new')
  assert.match(grid.sqlPreview(), /^UPDATE `db`\.`public`\.`people` SET `name`/)
  grid.setDialect('postgresql')
  assert.match(grid.sqlPreview(), /^UPDATE "db"\."public"\."people" SET "name"/)
  grid.setDialect('sqlserver')
  assert.match(grid.sqlPreview(), /^UPDATE \[db\]\.\[public\]\.\[people\] SET \[name\]/)
})

test('completed database batches invalidate local undo in only their own result snapshot', () => {
  const grid = makeGrid()
  grid._applyCell(0, 1, 'committed'); const changes = grid.toRowChanges(), source = grid.captureState()
  grid.setResult({ result: { columns, rows: [[9, 'other', true]] }, tableRef: { table: 'other' }, driverUpdatable: true })
  grid._applyCell(0, 1, 'other edit')
  const completed = grid.applyBatchResultToState(source, { results: [{ index: 0, ok: true }] }, changes)
  assert.equal(completed.snapshot.undoStack.length, 0)
  assert.equal(grid.undoStack.length, 1)
  assert.equal(grid.rowState.get(0).current[1], 'other edit')
})

test('successful deletes use stable tombstones and successful inserts remain read-only until refreshed', () => {
  const grid = makeGrid()
  grid.selectedRows.add(0); grid.markDeleteSelected()
  const inserted = grid.insertRow()
  grid._applyCell(inserted, 1, 'new person')
  const changes = grid.toRowChanges(), source = grid.captureState()
  const completed = grid.applyBatchResultToState(source, { results: changes.map((_, index) => ({ index, ok: true })) }, changes)
  assert.equal(source.committedDeletedRows.size, 0, 'background application must not mutate the retained source')
  grid.restoreState(completed.snapshot)
  assert.deepEqual(grid.viewAllIdxs, [1, 2])
  assert.equal(grid.rows.length, 3)
  assert.deepEqual(grid._keyOf(1), { id: 2 }, 'remaining row identity keeps its original index')
  assert.equal(grid._getRow(0), null)
  assert.equal(grid.rowState.get(inserted).committedInsert, true)
  assert.equal(grid._applyCell(inserted, 1, 'unsafe second update'), false)
  assert.equal(grid.pendingChanges().length, 0)
  assert.equal(grid.getExportData().rows.at(-1)[1], 'new person')
  grid.revertAll()
  assert.equal(grid._getRow(0), null)
  assert.equal(grid._getRow(inserted)[1], 'new person')
})

test('missing batch outcomes preserve local changes and cannot report success', () => {
  const grid = makeGrid()
  grid._applyCell(0, 1, 'pending')
  const changes = grid.toRowChanges()
  const outcome = grid.applyBatchResult({ ok: false, results: [] }, changes)
  assert.equal(outcome.anyFail, true)
  assert.equal(grid.pendingChanges().length, 1)
  assert.equal(grid.rowState.get(0).current[1], 'pending')
})

test('generic SQLite SELECT without identity remains read-only; a host-editable empty table can accept inserts', () => {
  const grid = new BufferGrid({})
  const unkeyed = [{ name: 'id', dataType: 'INTEGER' }, { name: 'name', dataType: 'TEXT' }]
  grid.setResult({ result: { columns: unkeyed, rows: [['1', 'Native alpha']] }, tableRef: { table: 'customers' }, driverUpdatable: true })
  assert.equal(grid.editable, false)
  assert.equal(grid._applyCell(0, 1, 'unsafe'), false)
  grid.updateColumnMetadata(unkeyed.map(column => ({ ...column, comment: 'label metadata' })))
  assert.equal(grid.editable, false, 'label enrichment must not grant edit authority')
  grid.setResult({ result: { columns: unkeyed, rows: [], editable: true }, tableRef: { table: 'customers' }, driverUpdatable: true })
  assert.equal(grid.editable, true)
  assert.equal(grid.insertRow(), 0)
  grid.setResult({ result: { columns: unkeyed, rows: [], editable: false }, tableRef: { table: 'customers' }, driverUpdatable: true })
  assert.equal(grid.editable, false)
})

test('a successful primary-key edit updates subsequent row identity without mutating the source snapshot', () => {
  const grid = makeGrid()
  grid._applyCell(0, 0, 42)
  const changes = grid.toRowChanges(), source = grid.captureState()
  const outcome = grid.applyBatchResultToState(source, { results: [{ index: 0, ok: true }] }, changes)
  assert.deepEqual(source.rowIdentity.keys[0], [1])
  grid.restoreState(outcome.snapshot)
  grid._applyCell(0, 1, 'after key changed')
  assert.deepEqual(grid.toRowChanges()[0].key, { id: 42 })
  assert.deepEqual(grid._keyOf(0), { id: 42 })
})

test('native table-page identity protects primary keys even when column descriptors omit PK flags', () => {
  const grid = new BufferGrid({})
  grid.setResult({ result: { columns: [{ name: 'id', dataType: 'INTEGER' }, { name: 'name', dataType: 'TEXT' }], rows: [['1', 'Native alpha'], ['2', 'Native beta']], editable: true, rowIdentity: { keyColumns: ['id'], keys: [['1'], ['2']] } }, tableRef: { table: 'customers' }, driverUpdatable: true })
  assert.equal(grid._isPrimaryColumn(0), true)
  assert.equal(grid._isPrimaryColumn(1), false)
  assert.throws(() => grid.applyCellEdits([{ row: 0, column: 0, value: null }]), /不能设为 NULL/)
  grid.selectedRows = new Set([0, 1]); grid.duplicateSelectedRows()
  assert.deepEqual(grid.insertedRows.map(row => row.values), [[null, 'Native alpha'], [null, 'Native beta']])
})
