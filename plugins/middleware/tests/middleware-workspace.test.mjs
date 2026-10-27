import test from 'node:test'
import assert from 'node:assert/strict'
import { restoreTasks, taskId, bindTaskApi } from '../src/js/workspace.js'
import { jsonSuggestions, collectJsonKeys, newlineEdit } from '../src/js/editorSuggestions.js'

const connections = [{ id: 'a', kind: 'kafka' }, { id: 'b', kind: 'rocketmq' }]
test('restores legacy connection tabs and filters duplicate or incompatible tasks', () => {
  assert.deepEqual(restoreTasks({ openTabs: ['a', 'b'], lastPage: { a: 'messages', b: 'trace' } }, connections), [{ id: 'a:messages', connectionId: 'a', pageId: 'messages' }, { id: 'b:trace', connectionId: 'b', pageId: 'trace' }])
  assert.equal(restoreTasks({ workspace: { tabs: [{ connectionId: 'a', pageId: 'trace' }, { connectionId: 'a', pageId: 'messages' }, { connectionId: 'a', pageId: 'messages' }, { connectionId: 'deleted', pageId: 'overview' }] } }, connections).length, 1)
  assert.notEqual(taskId('a:b', 'messages'), taskId('a', 'b:messages'))
})
test('task API pins session and surface even if callers supply another target', async () => {
  const calls = [], sessions = []
  const api = { mw: async (action, input) => calls.push({ action, input }), session: { get: key => sessions.push(key), set: (key, value) => sessions.push([key, value]), remove: key => sessions.push(key) } }
  const scoped = bindTaskApi(api, 'mw:a')
  await scoped.mw('messages.query', { sessionKey: 'mw:b', surface: 'quick', topic: 'orders' })
  assert.deepEqual(calls[0].input, { sessionKey: 'mw:a', surface: 'shell', topic: 'orders', from: 'latest' })
  scoped.session.get('monitor.series')
  assert.equal(sessions[0], 'mw:a:monitor.series')
})
test('read only API rejects writes before IPC and ignores responses after closing', async () => {
  let alive = true, finish, calls = 0
  const api = { mw: () => { calls++; return new Promise(resolve => { finish = resolve }) }, session: {} }
  await assert.rejects(bindTaskApi(api, 'mw:quick:a', { mode: 'quick' }).mw('messages.send', {}), /只读/)
  assert.equal(calls, 0)
  const pending = bindTaskApi(api, 'mw:a', { isAlive: () => alive }).mw('messages.query', {})
  alive = false; finish({ items: [] })
  await assert.rejects(pending, /旧响应/)
})
test('JSON suggestions are context-local and never rewrite quoted values', () => {
  assert.deepEqual(jsonSuggestions('{"active": tr', 13).map(item => item.label), ['true'])
  assert.deepEqual(jsonSuggestions('{"name": "tr', 12), [])
  assert.deepEqual(jsonSuggestions('{"active"', 9), [])
  const items = jsonSuggestions('{"co', 4, ['count', 'content-type'])
  assert.equal(items[0].text, 'count"')
  assert.equal(items[0].from, 2)
})
test('JSON key learning excludes invalid input and preserves escaped field names', () => {
  assert.deepEqual(collectJsonKeys('{"user":{"name":"Ada"},"rows":[{"id":1}]}'), ['user', 'name', 'rows', 'id'])
  assert.deepEqual(collectJsonKeys('{"password":'), [])
  assert.equal(jsonSuggestions('{"', 2, ['a"b'])[0].text, 'a\\"b"')
})
test('Enter aligns nested JSON without changing following content', () => {
  assert.deepEqual(newlineEdit('{}', 1), { from: 1, to: 1, text: '\n  \n', caret: 4 })
  assert.deepEqual(newlineEdit('  "value": 1,', 13), { from: 13, to: 13, text: '\n  ', caret: 16 })
})

test('closing during open serializes old cleanup before new session and never closes the new one', async () => {
  const { SessionCoordinator } = await import('../src/js/sessionCoordinator.js')
  const events = [], gates = []
  const sessions = new SessionCoordinator({ open: async (key, configuration) => { events.push(`open:${configuration.name}`); await new Promise(resolve => gates.push(resolve)); events.push(`ready:${configuration.name}`); return configuration.name }, close: async () => { events.push('close') } })
  const first = sessions.ensure('mw:a', { name: 'old' })
  const oldRejected = assert.rejects(first, /旧会话/)
  await Promise.resolve()
  const closing = sessions.invalidate('mw:a')
  const fresh = sessions.ensure('mw:a', { name: 'new' })
  await Promise.resolve()
  assert.deepEqual(events, ['open:old'])
  gates.shift()()
  await oldRejected; await closing
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['open:old', 'ready:old', 'close', 'close', 'open:new'])
  gates.shift()()
  assert.equal(await fresh, 'new')
  assert.equal(await sessions.ensure('mw:a', { name: 'new' }), 'new')
  assert.equal(events.at(-1), 'ready:new')
})

test('concurrent tasks share only the current generation and same configuration', async () => {
  const { SessionCoordinator } = await import('../src/js/sessionCoordinator.js')
  let opens = 0
  const sessions = new SessionCoordinator({ open: async () => ++opens, close: async () => {} })
  const first = sessions.ensure('mw:a', { readOnly: false })
  assert.equal(first, sessions.ensure('mw:a', { readOnly: false }))
  assert.equal(await first, 1)
  assert.equal(await sessions.ensure('mw:a', { readOnly: true }), 2)
})

test('late subscription startup is stopped if its task closed while starting', async () => {
  const events = []; let alive = true, finish
  const api = { mw: async (action, input) => { events.push({ action, input }); if (action === 'tail.start') await new Promise(resolve => { finish = resolve }) }, session: {} }
  const start = bindTaskApi(api, 'mw:a', { isAlive: () => alive }).mw('tail.start', { tailId: 't1' })
  alive = false; finish()
  await assert.rejects(start, /旧响应/)
  assert.equal(events[1].action, 'tail.stop')
  assert.equal(events[1].input.sessionKey, 'mw:a')
  assert.equal(events[1].input.tailId, 't1')
})
