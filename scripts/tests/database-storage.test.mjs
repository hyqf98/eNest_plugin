import test from 'node:test'
import assert from 'node:assert/strict'
import { toStorageJson } from '../../plugins/database/src/js/storageJson.js'

test('database JSON boundary omits optional object fields without mutating callers', () => {
  const input = { port: undefined, options: { ssl: false, absent: undefined }, values: [null, { absent: undefined, empty: '' }] }
  const saved = toStorageJson(input)
  assert.deepEqual(saved, { options: { ssl: false }, values: [null, { empty: '' }] })
  assert.equal(Object.hasOwn(input, 'port'), true)
  input.options.ssl = true
  assert.equal(saved.options.ssl, false)
})

test('database JSON boundary rejects values JSON would silently lose or change', () => {
  const cycle = {}; cycle.self = cycle
  for (const value of [undefined, [undefined], Array(1), NaN, Infinity, 1n, Symbol('x'), () => {}, new Date(), new Map(), { [Symbol('x')]: 1 }, cycle]) {
    assert.throws(() => toStorageJson(value))
  }
  const shared = { number: 0 }
  assert.deepEqual(toStorageJson([shared, shared]), [{ number: 0 }, { number: 0 }])
})
