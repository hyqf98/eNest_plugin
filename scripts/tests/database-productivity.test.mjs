import './register-db-alias.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { format } from 'sql-formatter'
import { CommandRegistry } from '@enest/plugin-kit/workbench'

globalThis.window = { addEventListener() {}, enest: { ui: { toast: async () => {} } } }
globalThis.document = { addEventListener() {} }
const { indentEdit, newlineEdit, commentEdit } = await import('../../plugins/com.enest.database/src/js/editor.js')
const { SqlEditor } = await import('../../plugins/com.enest.database/src/js/monacoEditor.js')
const { DatabaseWorkbench } = await import('../../plugins/com.enest.database/src/js/workbench.js')
delete globalThis.window
delete globalThis.document

const apply = (value, edit) => value.slice(0, edit.start) + edit.text + value.slice(edit.end)

test('Enter creates an indented inner line between brackets and keeps the closing bracket aligned', () => {
  const source = '  SELECT ()', edit = newlineEdit(source, 10)
  assert.equal(apply(source, edit), '  SELECT (\n    \n  )')
  assert.equal(edit.cursor, 15)
  assert.equal(apply('    WHERE active', newlineEdit('    WHERE active', 16)), '    WHERE active\n    ')
})

test('Tab and Shift+Tab preserve selection and do not indent the unselected next line', () => {
  const source = 'SELECT a\nFROM users\nWHERE active'
  const end = source.indexOf('WHERE'), indent = indentEdit(source, 0, end, 1)
  const indented = apply(source, indent)
  assert.equal(indented, '  SELECT a\n  FROM users\nWHERE active')
  assert.equal(indent.selectionEnd, end + 4)
  const restored = indentEdit(indented, 0, indent.selectionEnd, -1)
  assert.equal(apply(indented, restored), source)
  assert.equal(apply('SELECT x', indentEdit('SELECT x', 6, 6)), 'SELECT   x')
})

test('line comments preserve indentation and round trip multiline selections', () => {
  const source = '  SELECT a\n    FROM users\nWHERE active', end = source.indexOf('WHERE')
  const comment = commentEdit(source, 0, end)
  const commented = apply(source, comment)
  assert.equal(commented, '  -- SELECT a\n    -- FROM users\nWHERE active')
  const uncomment = commentEdit(commented, 0, comment.selectionEnd)
  assert.equal(apply(commented, uncomment), source)
})

function workbench(context) {
  const wb = Object.create(DatabaseWorkbench.prototype)
  wb.registry = new CommandRegistry(); wb.mode = 'shell'; wb.ctx = { message() {} }
  wb.shortcutContext = () => context
  const calls = []
  for (const [id, scope, shortcut] of [['run', 'query', 'Mod+Enter'], ['grid.commit', 'grid', 'Mod+Enter'], ['format', 'editor', 'Mod+Shift+F'], ['palette', 'workbench', 'Mod+Shift+P']]) wb.registry.register({ id, label: id, scope, shortcut, run: () => calls.push(id) })
  return { wb, calls }
}
const key = (key, flags = {}) => ({ key, code: key === ' ' ? 'Space' : '', metaKey: true, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, target: {}, ...flags })

test('SQL and table can share a shortcut without overlapping, while ordinary inputs retain their native shortcuts', () => {
  const query = workbench({ input: true, editor: true, query: true, grid: false })
  assert.equal(query.wb.handleShortcut(key('Enter')), true)
  assert.deepEqual(query.calls, ['run'])
  const grid = workbench({ input: false, editor: false, query: true, grid: true })
  grid.wb.handleShortcut(key('Enter')); assert.deepEqual(grid.calls, ['grid.commit'])
  const input = workbench({ input: true, editor: false, query: true, grid: false })
  assert.equal(input.wb.handleShortcut(key('Enter')), false)
  assert.deepEqual(input.calls, [])
})

test('rebound and disabled editor shortcuts suppress stale native defaults, and overlapping scopes reject conflicts', () => {
  const { wb, calls } = workbench({ input: true, editor: true, query: true, grid: false })
  wb.setCommandBinding('run', 'Mod+R')
  const old = key('Enter'); assert.equal(wb.handleShortcut(old), true); assert.equal(old.defaultPrevented, true)
  wb.handleShortcut(key('r')); assert.deepEqual(calls, ['run'])
  assert.throws(() => wb.setCommandBinding('format', 'Mod+R'), /冲突/)
  wb.setCommandBinding('grid.commit', 'Mod+R')
  assert.throws(() => wb.setCommandBinding('palette', 'Mod+R'), /冲突/)
  wb.setCommandBinding('format', '')
  const oldFormat = key('f', { shiftKey: true }); wb.handleShortcut(oldFormat)
  assert.equal(oldFormat.defaultPrevented, true); assert.deepEqual(calls, ['run'])
})

test('selection formatting changes only selected SQL and rejects unsupported or invalid source without edits', async () => {
  const editor = Object.create(SqlEditor.prototype), source = 'select id,name from users;\nselect keep_me;'
  editor.documentId = 'query-a'; editor.format = format; editor.getDialect = () => 'mysql'
  editor.el = { ta: { value: source, selectionStart: 0, selectionEnd: source.indexOf('\n') } }
  const edits = []; editor._replaceRange = (...args) => edits.push(args)
  await editor.formatDocument(true)
  assert.equal(edits.length, 1)
  assert.equal(edits[0][1], source.indexOf('\n'))
  assert.match(edits[0][2], /SELECT\n  id,/)
  assert.equal(source.slice(edits[0][1]), '\nselect keep_me;')
  editor.el.ta.selectionEnd = 0
  await assert.rejects(editor.formatDocument(true), /请先选择/)
  editor.getDialect = () => 'neo4j'
  await assert.rejects(editor.formatDocument(), /当前原生查询语言/)
  assert.equal(edits.length, 1)
})
