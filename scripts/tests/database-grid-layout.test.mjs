import test from 'node:test'
import assert from 'node:assert/strict'
import { columnAlignment, estimateColumnWidth, createGridLayout } from '../../plugins/database/src/js/gridLayout.js'

test('column alignment follows declared SQL types without treating IDs or protocol codes as numbers', () => {
  for (const type of ['INT', 'bigint unsigned', 'decimal(18, 8)', 'double precision', 'NUMERIC(12,2)', 'int4', 'Float64', 'Nullable(Int32)']) {
    assert.equal(columnAlignment({ dataType: type }), 'numeric', type)
  }
  for (const type of ['bool', 'BOOLEAN']) assert.equal(columnAlignment({ type }), 'boolean')
  for (const type of ['varchar(20)', 'uuid', 'json', 'int[]', '_int4', '253', 'bit(8)', 'point', '']) {
    assert.equal(columnAlignment({ dataType: type }), 'text', type)
  }
  assert.equal(columnAlignment({ dataType: 253, type: 'INTEGER' }), 'numeric')
  assert.equal(columnAlignment({ name: 'id' }), 'text')
})

test('default widths keep numeric, text, dates and structured data readable, with a bounded comment', () => {
  assert.equal(estimateColumnWidth({ name: 'id', type: 'INTEGER' }, [1, 2]), 120)
  assert.equal(estimateColumnWidth({ name: 'code', type: 'TEXT' }, ['000001']), 160)
  assert.equal(estimateColumnWidth({ name: 'date', type: 'DATE' }, ['2026-10-14']), 180)
  assert.equal(estimateColumnWidth({ name: 'payload', type: 'JSON' }, [{}]), 220)
  assert.ok(estimateColumnWidth({ name: 'a', type: 'TEXT' }, ['一'.repeat(12)]) > 160)
  assert.ok(estimateColumnWidth({ name: 'a', comment: '备注'.repeat(1000) }) <= 260)
  assert.equal(estimateColumnWidth({ name: 'long', type: 'TEXT' }, ['x'.repeat(2000)]), 280)
  assert.equal(columnAlignment({ name: 'code', type: 'TEXT' }), 'text', 'leading-zero identifiers retain textual alignment')
})

test('sampling is limited to fifty rows and supports null, large integers and structured values', () => {
  const samples = Array(50).fill('short').concat('x'.repeat(2000))
  assert.equal(estimateColumnWidth({ name: 'value', type: 'TEXT' }, samples), 160)
  assert.ok(estimateColumnWidth({ type: 'bigint' }, [900719925474099312345n]) > 120)
  const circular = {}; circular.self = circular
  assert.doesNotThrow(() => estimateColumnWidth({ type: 'JSON' }, [null, {}, circular, new Date('invalid')]))
})

test('many columns overflow without shrinking and all grid layers share an exact pixel template', () => {
  const columns = Array.from({ length: 12 }, (_, i) => ({ name: `value_${i}`, type: 'TEXT' }))
  const layout = createGridLayout(columns, [], { viewportWidth: 480 })
  assert.deepEqual(layout.widths, Array(12).fill(160))
  assert.equal(layout.leadingWidth, 76)
  assert.equal(layout.totalWidth, 2076)
  assert.equal(layout.template, [32, 44, ...layout.widths, 80].map(width => `${width}px`).join(' '))
  assert.equal(layout.template.split(' ').reduce((sum, value) => sum + parseInt(value), 0), layout.totalWidth)
})

test('few columns fill available space with deterministic integer widths', () => {
  const columns = [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }, { name: 'active', type: 'BOOLEAN' }]
  const layout = createGridLayout(columns, [], { viewportWidth: 800.9 })
  assert.deepEqual(layout.widths, [202, 241, 201])
  assert.equal(layout.totalWidth, 800)
  assert.ok(layout.widths.every(Number.isInteger))
})

test('explicit resized widths remain direct while unresized columns fill the remaining viewport', () => {
  const columns = [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }]
  const first = createGridLayout(columns, [], { viewportWidth: 800, widths: { 0: 130 } })
  const dragged = createGridLayout(columns, [], { viewportWidth: 800, widths: { 0: 145 } })
  assert.deepEqual(first.widths, [130, 514])
  assert.deepEqual(dragged.widths, [145, 499])
  assert.deepEqual(createGridLayout(columns, [], { viewportWidth: 800, widths: new Map([[0, 130], [1, 160]]) }).widths, [130, 160])
  assert.equal(createGridLayout(columns, [], { widths: { 0: 1 } }).widths[0], 96)
  assert.equal(createGridLayout(columns, [], { widths: { 0: Infinity } }).widths[0], 120)
})

test('font scaling applies to estimates and auxiliary tracks while keeping persisted widths in pixels', () => {
  const columns = [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }]
  const layout = createGridLayout(columns, [], { scale: 1.5, widths: { 0: 200 } })
  assert.deepEqual(layout.widths, [200, 240])
  assert.equal(layout.selectionWidth, 48)
  assert.equal(layout.indexWidth, 66)
  assert.equal(layout.statusWidth, 120)
  assert.equal(layout.totalWidth, 674)
  assert.equal(estimateColumnWidth(columns[1], [], 1.5), 240)
  assert.equal(createGridLayout(columns, [], { scale: NaN }).totalWidth, createGridLayout(columns).totalWidth)
})

test('empty results and object-shaped sample rows produce finite geometry without mutation', () => {
  const columns = Object.freeze([Object.freeze({ name: 'description', type: 'TEXT' })])
  const rows = Object.freeze([Object.freeze({ description: 'x'.repeat(100) })])
  assert.equal(createGridLayout(columns, rows).widths[0], 280)
  assert.equal(createGridLayout([], [], { viewportWidth: Infinity }).totalWidth, 156)
  assert.deepEqual(createGridLayout().widths, [])
})
