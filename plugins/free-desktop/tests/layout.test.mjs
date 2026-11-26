import assert from 'node:assert/strict'
import test from 'node:test'
import { change, homeScreen, initial, readLayout } from '../src/model.js'
import { workspaceStore } from '../src/persistence.js'

const screens = [{ id: 'internal', primary: true }, { id: 'external', primary: false }]

test('a temporary monitor fallback does not replace the chosen Dock home', () => {
  const layout = change(initial(), { action: 'dockScreen', value: 'external' }, 'internal', screens)
  assert.equal(homeScreen(layout.dock.screen, [screens[0]]), 'internal')
  assert.equal(homeScreen(layout.dock.screen, screens), 'external')
  assert.equal(layout.dock.screen, 'external')
})

test('a surface cannot change a region on another visible screen', () => {
  assert.throws(() => change(initial(), { action: 'remove', id: 'memo' }, 'external', screens))
  assert.throws(() => readLayout({ ...initial(), blocks: [{ id: '__proto__', kind: 'note', screen: 'primary' }] }))
})

test('region changes and their index share one commit, missing records fail closed', async () => {
  const values = new Map(), commits = []
  const storage = { get: async key => values.get(key), commit: async ops => {
    commits.push(ops); for (const op of ops) if (op.op === 'set') values.set(op.key, structuredClone(op.value)); else values.delete(op.key)
  } }
  const store = workspaceStore(storage), before = await store.read()
  const after = change(before, { action: 'note', id: 'memo', text: '持久化便签' }, 'internal', screens)
  await store.commit(before, after)
  assert.equal(commits.length, 1)
  assert.deepEqual(await workspaceStore(storage).read(), after)
  const regionKey = commits[0].find(op => op.value?.id === 'memo').key
  values.delete(regionKey)
  await assert.rejects(workspaceStore(storage).read(), /区域记录缺失/)
  assert.equal(commits.length, 1)
})
