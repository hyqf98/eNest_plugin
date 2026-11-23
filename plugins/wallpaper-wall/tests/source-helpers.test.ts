import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildUrl,
  filterList,
  filterString,
  pageNumber,
  pageSize,
  stripHtml,
} from '../backend/sources/types.ts'

test('buildUrl omits empty values and encodes query', () => {
  const url = buildUrl('https://example.com/api', { q: 'nature wallpaper', page: 2, empty: '', missing: undefined, flag: false })
  assert.equal(url, 'https://example.com/api?q=nature+wallpaper&page=2&flag=false')
})

test('query helpers clamp pagination and filters', () => {
  assert.equal(pageNumber({ sourceId: 'x', requestId: 'r' }), 1)
  assert.equal(pageNumber({ sourceId: 'x', requestId: 'r', page: -2 }), 1)
  assert.equal(pageSize({ sourceId: 'x', requestId: 'r', perPage: 999 }, 24, 60), 60)
  assert.equal(filterString({ quality: 'high' }, 'quality'), 'high')
  assert.deepEqual(filterList({ tags: ['a', 2, 'b'] }, 'tags'), ['a', 'b'])
})

test('stripHtml removes tags and decodes common entities', () => {
  assert.equal(stripHtml('<b>A &amp; B</b><br/>C&#39;s'), "A & B C's")
})
