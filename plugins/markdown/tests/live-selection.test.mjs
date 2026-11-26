import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorSelection, EditorState } from '@codemirror/state'
import { AtomicBlockWidget } from '../src/cm/blockWidgets.js'
import { liveField, setEditorFocus, setLiveEnabled, setComposing } from '../src/cm/liveBlocks.js'
import { tableSelection } from '../src/cm/tableUI.js'

const content = '| 表头 |\n| --- |\n| 中文 |\n\n```mermaid\ngraph LR\n A --> B\n```\n\n> 引用\n'
const makeState = (doc = content) => EditorState.create({ doc, extensions: [liveField] })
const select = (state, anchor, head = anchor) => state.update({ selection: EditorSelection.single(anchor, head), userEvent: 'select' }).state
function previews(state) {
  const ranges = []
  for (const cursor = state.field(liveField).decorations.iter(); cursor.value; cursor.next()) {
    if (cursor.value.spec.widget instanceof AtomicBlockWidget) ranges.push([cursor.from, cursor.to])
  }
  return ranges
}

test('仅改变选区即可展开块；表格末尾及图表开头都不能把插入点留在预览里', () => {
  const initial = makeState()
  const [table, diagram] = previews(initial)
  assert.equal(table[0], 0)
  assert.deepEqual(previews(select(initial, table[1])), [diagram])
  assert.deepEqual(previews(select(initial, diagram[0])), [table])
  assert.deepEqual(previews(select(initial, table[1], diagram[1])), [])
  assert.deepEqual(previews(select(initial, content.length, 0)), [])
  const quote = select(initial, content.indexOf('引用'))
  assert.deepEqual(previews(quote), [table, diagram])
  const tail = select(quote, content.length)
  assert.strictEqual(tail.field(liveField).decorations, quote.field(liveField).decorations)
  assert.ok(previews(tail).every(([, end]) => end < tail.selection.main.head))
})

test('两张内容一样的表格不互借 DOM；在前面插字后，原表格仍拥有相同身份', () => {
  const table = '| 列 |\n| -- |'
  const state = makeState(`序\n\n${table}\n\n${table}`)
  const keys = editor => editor.field(liveField).blocks.filter(block => block.type === 'table').map(block => block.key)
  const [first, second] = keys(state)
  assert.notEqual(first, second)
  assert.deepEqual(keys(state.update({ changes: { from: 0, insert: '前' } }).state), [first, second])
})

test('表格内的原生选区写回源码偏移，但不会拆掉正在接收输入的单元格', () => {
  const initial = makeState()
  const position = content.indexOf('中文') + 1
  const editing = select(initial, position)
  const inCell = editing.update({ selection: { anchor: position }, annotations: tableSelection.of(true), userEvent: 'select.table' }).state
  assert.equal(inCell.field(liveField).config.editing, false)
  assert.equal(inCell.selection.main.head, position)
  assert.deepEqual(previews(inCell), previews(initial))
  const history = inCell.update({ selection: { anchor: position - 1 }, userEvent: 'undo' }).state
  assert.deepEqual(previews(history), previews(initial))
})

test('输入法组字期间保留装饰；失焦或切换源码不会改动 Markdown 或文档选区', () => {
  const state = select(makeState(), content.indexOf('graph'))
  const composing = state.update({ effects: setComposing.of(true) }).state
  const inserted = composing.update({ changes: { from: content.indexOf('graph'), insert: '流程' } }).state
  assert.deepEqual(previews(inserted), previews(state))
  const ended = inserted.update({ effects: [setComposing.of(false), setEditorFocus.of(false)] }).state
  assert.equal(previews(ended).length, 2)
  const source = ended.update({ effects: setLiveEnabled.of(false) }).state
  assert.equal(source.field(liveField).decorations.size, 0)
  assert.ok(source.selection.eq(ended.selection))
  assert.ok(source.doc.eq(ended.doc))
})
