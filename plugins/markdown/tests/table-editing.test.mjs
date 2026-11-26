import test from 'node:test'
import assert from 'node:assert/strict'
import { cellTextOffset } from '../src/cm/tablePoints.js'
import { changedText } from '../src/js/textChange.js'
import {
  cellInputValue, cellSourceValue, deleteRow, insertColumn, insertRow, parseTable, serializeTable, tableCellRange, tableRowCells,
} from '../src/render/tableOps.js'

test('table caret identifies the touched row and column, including escaped pipes and repeated CJK text', () => {
  const header = '姓名 | 示例'
  const source = [header, ':----- | --:', '| 重复 | 重复 |', '| 重复 | 重复\\|字符🙂 |'].join('\n')
  const range = tableCellRange(source, 2, 1)
  assert.equal(range.from, source.lastIndexOf('重复'))
  assert.equal(source.slice(range.from, range.to), '重复\\|字符🙂')
  assert.equal(cellInputValue(range.value), '重复|字符🙂')
  assert.deepEqual(tableRowCells(header).map(cell => cell.value), ['姓名', '示例'])
  assert.equal(cellSourceValue('文字|第二行\r\n🙂'), '文字\\|第二行<br>🙂')
})

test('an auto-filled GFM body cell can be edited without rewriting its row or neighbouring rows', () => {
  const source = '一|二|三\n---|:---:|---:\n| 已有 |\n| 保持 | 原样 |'
  const range = tableCellRange(source, 1, 2)
  assert.equal(range.from, range.to)
  const result = source.slice(0, range.from) + range.prefix + '新增' + range.suffix + source.slice(range.to)
  assert.equal(result, '一|二|三\n---|:---:|---:\n| 已有 |  | 新增 |\n| 保持 | 原样 |')
  assert.equal(tableCellRange(result, 1, 2).value, '新增')
})

test('table structure changes retain intentional alignments, cell escapes and unrelated row spacing', () => {
  const source = 'first | second\n------|:----:\n|    left\\|pipe | extra   |\n  tail| second|unrendered extra'
  const table = parseTable(source)
  assert.equal(serializeTable(table), source)
  assert.equal(serializeTable(deleteRow(insertRow(table, 1), 1)), source)
  const added = parseTable(serializeTable(insertColumn(table, 1)))
  assert.deepEqual(added.delimiters, ['------', '---', ':----:'])
  assert.deepEqual(added.rows, [['left\\|pipe', '', 'extra'], ['tail', '', 'second', 'unrendered extra']])
})

test('neighbouring formatted runs resolve to the side of the boundary that was touched', () => {
  const source = '**中**[文](https://example.test/文)'
  assert.equal(cellTextOffset(source, '中文', 1, { assoc: -1 }), source.indexOf('中') + 1)
  assert.equal(cellTextOffset(source, '中文', 1, { assoc: 1 }), source.indexOf('文'))
  assert.equal(cellTextOffset(source, '中文', 2), source.indexOf('文') + 1)
  const mixed = '`` ==字== ``==标记==&amp;$x$'
  const rendered = '==字==标记&x'
  assert.equal(cellTextOffset(mixed, rendered, rendered.indexOf('标'), { decodeEntity: () => '&', formulae: ['x'] }), mixed.indexOf('标'))
  assert.equal(cellTextOffset(mixed, rendered, rendered.indexOf('x'), { decodeEntity: () => '&', formulae: ['x'] }), mixed.indexOf('x'))
})

test('literal HTML, unresolved link syntax, and rendered math do not shift a following caret', () => {
  const literal = '<b>[未定义]</b>**文**'
  const rendered = '<b>[未定义]</b>文'
  assert.equal(cellTextOffset(literal, rendered, rendered.indexOf('文'), { renderHtml: false }), literal.indexOf('文'))
  const formula = '值$\\sqrt{x}$末尾'
  assert.equal(cellTextOffset(formula, '值√x末尾', 3, { formulae: ['√x'] }), formula.indexOf('末'))
})

test('minimal source updates stay on UTF-16 boundaries for repeated text and emoji sharing a high surrogate', () => {
  assert.deepEqual(changedText('甲🙂乙', '甲😊乙'), { from: 1, to: 3, insert: '😊' })
  assert.deepEqual(changedText('相同相同甲', '相同相同乙'), { from: 4, to: 5, insert: '乙' })
  assert.deepEqual(changedText('不变', '不变'), { from: 2, to: 2, insert: '' })
})
