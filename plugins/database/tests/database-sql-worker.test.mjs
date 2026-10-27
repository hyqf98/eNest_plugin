import './register-db-alias.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
const { EngineClient } = await import('@db/sql-intelligence/runtime/EngineClient.js')

const tick = () => new Promise(resolve => setImmediate(resolve))
const request = (documentId, sql = 'SELECT 1') => ({ documentId, sql, connectionId: 'a', consoleId: 'console-a' })
function client(options = {}) {
  const workers = []
  const service = new EngineClient({
    createWorker: () => {
      const worker = { messages: [], terminated: false, postMessage(data) { this.messages.push(data) }, terminate() { this.terminated = true }, reply(result = { items: ['latest'] }, id = this.messages.at(-1).id) { this.onmessage({ data: { id, result } }) } }
      workers.push(worker)
      return worker
    },
    ...options
  })
  return { service, workers }
}

test('same-document queued keystrokes dispatch only the latest request', async () => {
  const { service, workers } = client()
  const tasks = Array.from({ length: 20 }, (_, index) => service.run('complete', request('a', `SELECT ${index}`), {}))
  assert.equal(service.pending.size, 1)
  await tick()
  assert.equal(workers.length, 1)
  assert.equal(workers[0].messages.length, 1)
  assert.equal(workers[0].messages[0].request.sql, 'SELECT 19')
  workers[0].reply()
  const results = await Promise.all(tasks)
  assert.equal(results.filter(result => result.cancelled).length, 19)
  assert.deepEqual(results.at(-1).items, ['latest'])
  service.dispose()
})

test('superseding an active parse terminates it and preserves other documents in the queue', async () => {
  const { service, workers } = client()
  const old = service.run('complete', request('a', 'old'), {})
  await tick()
  const other = service.run('complete', request('b', 'other'), {})
  const latest = service.run('complete', request('a', 'latest'), {})
  assert.equal((await old).cancelled, true)
  assert.equal(workers[0].terminated, true)
  await tick()
  assert.equal(workers[1].messages[0].request.sql, 'other')
  workers[0].reply({ items: ['stale'] })
  assert.equal(service.pending.size, 2)
  workers[1].reply({ items: ['other'] })
  assert.deepEqual((await other).items, ['other'])
  await tick()
  assert.equal(workers[1].messages[1].request.sql, 'latest')
  workers[1].reply()
  assert.deepEqual((await latest).items, ['latest'])
  service.dispose()
})

test('a timeout belongs to the dispatched task and leaves a later queued request alive', async () => {
  const { service, workers } = client({ timeoutMs: 20 })
  const slow = service.run('complete', request('a'), {})
  const rejected = assert.rejects(slow, /SQL 分析超时/)
  const latest = service.run('complete', request('b'), {})
  await rejected
  assert.equal(workers[0].terminated, true)
  assert.equal(workers.length, 2)
  workers[1].reply()
  assert.deepEqual((await latest).items, ['latest'])
  service.dispose()
})

test('AbortSignal cancels active parsing and dispose never reopens a Worker', async () => {
  const { service, workers } = client()
  const controller = new AbortController()
  const active = service.run('complete', request('a'), {}, { signal: controller.signal })
  await tick(); controller.abort()
  assert.equal((await active).cancelled, true)
  assert.equal(workers[0].terminated, true)
  const pending = service.run('complete', request('b'), {})
  service.dispose()
  assert.equal((await pending).cancelled, true)
  assert.equal((await service.run('complete', request('c'), {})).cancelled, true)
  assert.equal(service.pending.size, 0)
  await tick()
  assert.equal(workers.length, 1)
})

test('pending documents are bounded and signature/diagnostics use independent queue keys', async () => {
  const { service, workers } = client({ maxPending: 3 })
  const dropped = service.run('complete', request('old-document'), {})
  const completion = service.run('complete', request('a'), {})
  const signature = service.run('signature', request('a'), {})
  const diagnostics = service.run('complete', request('a'), {}, { key: 'diagnostics:a' })
  assert.equal((await dropped).cancelled, true)
  assert.equal(service.pending.size, 3)
  for (let index = 0; index < 3; index++) { await tick(); workers[0].reply({ order: index }) }
  assert.deepEqual(await Promise.all([completion, signature, diagnostics]), [{ order: 0 }, { order: 1 }, { order: 2 }])
  service.dispose()
})

test('unavailable Worker construction falls back locally and preserves latest-wins', async () => {
  const service = new EngineClient({ createWorker: () => { throw new Error('Worker unavailable') }, loadEngine: async () => ({ buildCompletion: request => ({ sql: request.sql }) }) })
  const old = service.run('complete', request('a', 'old'), {})
  const latest = service.run('complete', request('a', 'latest'), {})
  assert.equal((await old).cancelled, true)
  assert.deepEqual(await latest, { sql: 'latest' })
  service.dispose()
})
