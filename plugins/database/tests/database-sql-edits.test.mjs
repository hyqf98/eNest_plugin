import test from 'node:test'
import assert from 'node:assert/strict'
import './register-db-alias.mjs'
const { plainSnippet, prepareEdits } = await import('@db/sql-intelligence/runtime/editorEdits.js')

test('plain previews retain linked placeholders and select the first numbered parameter', () => {
  const result = plainSnippet('SELECT ${1:name}, $1 FROM ${2:customers} WHERE ${1};$0')
  assert.equal(result.text, 'SELECT name, name FROM customers WHERE name;')
  assert.equal(result.text.slice(result.selection.from, result.selection.to), 'name')
  assert.equal(plainSnippet('SELECT \\$1, ${1:value}').text, 'SELECT $1, value')
})
test('compound completion selections account for preceding additional edits', () => {
  const result = prepareEdits('SELECT x FROM t;', { editPlan: { from: 7, to: 8, text: '${1:customer}', snippet: '${1:customer}', additionalEdits: [{ from: 0, to: 0, text: '-- sample\n' }] } })
  assert.equal(result.result, '-- sample\nSELECT customer FROM t;')
  assert.equal(result.result.slice(result.selection.from, result.selection.to), 'customer')
})

test('ordinary SQL values preserve literal dollar parameters and backslashes', () => {
  const value = "COALESCE($1, '$2')"
  assert.equal(prepareEdits('', { editPlan: { from: 0, to: 0, text: value } }).result, value)
})
