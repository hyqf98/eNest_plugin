/**
 * 多选模型的回归测试：普通点击、Ctrl/Cmd 追加、Shift 范围选择。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { applySelection } from '../src/js/selection.ts'

const order = ['a', 'b', 'c', 'd', 'e']
const none = { selected: [] as string[], anchor: null, order }

test('普通点击只选中被点的条目', () => {
  assert.deepEqual(applySelection({ ...none, id: 'c', shift: false, toggle: false }), { selected: ['c'], anchor: 'c' })
})

test('Ctrl/Cmd 点击追加，再点一次取消', () => {
  const added = applySelection({ ...none, selected: ['c'], anchor: 'c', id: 'a', shift: false, toggle: true })
  assert.deepEqual(added, { selected: ['c', 'a'], anchor: 'a' })
  const removed = applySelection({ ...none, ...added, id: 'a', shift: false, toggle: true })
  assert.deepEqual(removed, { selected: ['c'], anchor: 'c' })
})

test('取消到空选择时锚点一并清掉', () => {
  assert.deepEqual(applySelection({ ...none, selected: ['c'], anchor: 'c', id: 'c', shift: false, toggle: true }), { selected: [], anchor: null })
})

test('Shift 以锚点和当前点击为两端替换原有选择，方向不限', () => {
  assert.deepEqual(applySelection({ ...none, selected: ['b'], anchor: 'b', id: 'e', shift: true, toggle: false }), { selected: ['b', 'c', 'd', 'e'], anchor: 'b' })
  assert.deepEqual(applySelection({ ...none, selected: ['e'], anchor: 'e', id: 'b', shift: true, toggle: false }), { selected: ['b', 'c', 'd', 'e'], anchor: 'e' })
  assert.deepEqual(applySelection({ ...none, selected: ['a', 'e'], anchor: 'e', id: 'c', shift: true, toggle: false }), { selected: ['c', 'd', 'e'], anchor: 'e' })
})

test('没有锚点时 Shift 以本次点击为起点；锚点不在当前列表里时退化为单选', () => {
  assert.deepEqual(applySelection({ ...none, id: 'c', shift: true, toggle: false }), { selected: ['c'], anchor: 'c' })
  assert.deepEqual(applySelection({ ...none, selected: ['x'], anchor: 'x', id: 'c', shift: true, toggle: false }), { selected: ['c'], anchor: 'c' })
})
