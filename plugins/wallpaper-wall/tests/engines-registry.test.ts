import assert from 'node:assert/strict'
import test from 'node:test'
import { engineDescriptors } from '../backend/engines/registry.ts'

test('engine registry has unique ids and a default builtin', () => {
  const ids = engineDescriptors.map(engine => engine.id)
  assert.equal(new Set(ids).size, ids.length)
  const builtin = engineDescriptors.find(engine => engine.id === 'builtin-light')
  assert.ok(builtin)
  assert.equal(builtin.default, true)
  assert.deepEqual(builtin.platforms, ['win32', 'darwin', 'linux'])
})

test('only the self-contained built-in engine is registered', () => {
  assert.deepEqual(engineDescriptors.map(engine => engine.id), ['builtin-light'])
  assert.equal(engineDescriptors[0]?.distribution, 'bundled')
})
