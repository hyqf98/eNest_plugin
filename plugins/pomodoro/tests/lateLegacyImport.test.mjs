import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlan, createPomodoroController, normalizeOptions } from '../src/timer/pomodoro.js'

const STORE = 'pomodoro_journal_v2'
const LEGACY = '_enest_migration.focus-timers-v1'
const clone = value => structuredClone(value)
const record = (id, task = id) => ({ id, task, phase: 'focus', startedAt: 1000, endedAt: 61000,
  durationMs: 60000, outcome: 'completed', counted: true })
const legacy = records => ({ state: { status: 'running', phase: 'focus', cycle: 1, remainingMs: 120000,
  startedAt: 1000, options: { focusMin: 50, breakMin: 10 } }, records })

function fixture() {
  const values = new Map(), state = { task: null, receipts: [], starts: 0, failHead: false, commits: [] }
  const snapshot = () => ({ task: clone(state.task), receipts: clone(state.receipts) })
  const api = {
    storage: {
      async get(key) { return values.has(key) ? clone(values.get(key)) : null },
      async set(key, value) {
        if (key === STORE && state.failHead) { state.failHead = false; throw new Error('fixture persistence failure') }
        values.set(key, clone(value))
      },
      async commit(operations) {
        state.commits.push(clone(operations))
        if (state.failHead) { state.failHead = false; throw new Error('fixture persistence failure') }
        for (const operation of operations) values.set(operation.key, clone(operation.value))
        return { commitId: 'fixture', committedAt: Date.now(), committedKeys: operations.map(operation => operation.key) }
      }
    },
    deadlineTasks: {
      async get() { return snapshot() },
      async start(input) {
        state.starts++
        state.task = { id: input.id, plan: clone(input), runId: `run-${state.starts}`,
          status: input.paused ? 'paused' : 'running', stepIndex: input.cursor?.stepIndex ?? 0,
          iteration: input.cursor?.iteration ?? 0, remainingMs: input.cursor?.remainingMs ?? input.steps[0].durationMs,
          deadline: input.paused ? null : Date.now() + input.steps[0].durationMs, startedAt: input.cursor?.startedAt ?? Date.now() }
        return snapshot()
      }
    }
  }
  const offer = value => {
    const json = typeof value === 'string' ? value : JSON.stringify(value), chunks = Math.ceil(json.length / 32768)
    values.set(LEGACY, { version: 1, chunks })
    for (let index = 0; index < chunks; index++) values.set(`${LEGACY}.${index}`, json.slice(index * 32768, (index + 1) * 32768))
  }
  const seed = ({ records = [], deleted = [], options = normalizeOptions(), legacyImported = true } = {}) => {
    values.set(STORE, { version: 2, bank: 'a', chunks: records.length ? 1 : 0, deleted, options, legacyImported })
    if (records.length) values.set(`${STORE}.a.0`, clone(records))
  }
  return { values, state, api, offer, seed, controller: () => createPomodoroController(api) }
}

test('a previously absent legacy source can later add history without restoring an obsolete session', async () => {
  const f = fixture(), controller = f.controller()
  await controller.get()
  assert.equal(f.values.get(STORE).legacyImported, true)
  assert.equal(f.values.get(STORE).legacySourceImported, false)
  f.offer(legacy([record('old')]))
  const result = await controller.get()
  assert.equal(result.state.status, 'idle')
  assert.equal(result.state.options.focusMin, 25)
  assert.equal(f.state.starts, 0)
  assert.deepEqual(result.records.map(item => item.id), ['old'])
  assert.equal(f.values.get(STORE).legacySourceImported, true)
  assert.deepEqual((await controller.get()).records.map(item => item.id), ['old'])
  assert.deepEqual((await f.controller().get()).records.map(item => item.id), ['old'])
})

test('older journals import late data by ID without overwriting edits, deleted rows or a current session', async () => {
  const f = fixture(), options = normalizeOptions({ focusMin: 45, breakMin: 7 })
  f.seed({ records: [record('shared', 'user edited'), record('current')], deleted: ['deleted'], options })
  await f.api.deadlineTasks.start(createPlan(options))
  const task = clone(f.state.task), starts = f.state.starts
  f.offer(legacy([record('shared', 'obsolete'), record('deleted'), record('late')]))
  const result = await f.controller().get()
  assert.deepEqual(f.state.task, task)
  assert.equal(f.state.starts, starts)
  assert.equal(result.state.options.focusMin, 45)
  assert.equal(result.records.find(item => item.id === 'shared').task, 'user edited')
  assert.equal(result.records.some(item => item.id === 'deleted'), false)
  assert.equal(new Set(result.records.map(item => item.id)).size, 3)
  assert.equal(result.records.filter(item => item.counted).length, 3)
  assert.equal(f.values.get(STORE).legacySourceImported, true)
})

test('invalid late payloads are not marked imported and can be retried after repair', async () => {
  const f = fixture(), controller = f.controller()
  await controller.get()
  f.offer('{invalid')
  await assert.rejects(controller.get(), SyntaxError)
  assert.equal(f.values.get(STORE).legacySourceImported, false)
  f.offer(legacy([record('repaired')]))
  assert.deepEqual((await controller.get()).records.map(item => item.id), ['repaired'])
  assert.equal(f.values.get(STORE).legacySourceImported, true)
})

test('a failed journal head commit does not mark a late source imported or duplicate records on retry', async () => {
  const f = fixture(), controller = f.controller()
  await controller.get()
  f.offer(legacy([record('retry')]))
  f.state.failHead = true
  await assert.rejects(controller.get(), /persistence failure/)
  assert.equal(f.values.get(STORE).legacySourceImported, false)
  assert.deepEqual((await controller.get()).records.map(item => item.id), ['retry'])
  assert.deepEqual((await f.controller().get()).records.map(item => item.id), ['retry'])
})

test('a first-use legacy source still restores its paused cursor and original options once', async () => {
  const f = fixture()
  f.offer(legacy([record('first')]))
  const result = await f.controller().get()
  assert.equal(result.state.status, 'paused')
  assert.equal(result.state.options.focusMin, 50)
  assert.equal(result.state.remainingMs, 120000)
  assert.equal(f.state.starts, 1)
  assert.equal(f.values.get(STORE).legacySourceImported, true)
  await f.controller().get()
  assert.equal(f.state.starts, 1)
})

test('a full journal commits its bank and pointer in one bounded transaction', async () => {
  const f = fixture()
  f.offer(legacy(Array.from({ length: 2000 }, (_, index) => record(`history-${index}`))))
  assert.equal((await f.controller().get()).records.length, 2000)
  assert.equal(f.state.commits.length, 1)
  const operations = f.state.commits[0]
  assert.equal(operations.length, 33)
  assert.ok(operations.every(operation => operation.op === 'set'))
  assert.equal(operations.at(-1).key, STORE)
  assert.equal(operations.at(-1).value.chunks, 32)
  assert.equal(operations.at(-1).value.legacySourceImported, true)
})

test('compatible hosts flush queued writes before migration is acknowledged and can retry a failed flush', async () => {
  const f = fixture(), queued = new Map()
  let flushes = 0, fail = true
  delete f.api.storage.commit
  f.api.storage.set = async (key, value) => { queued.set(key, clone(value)) }
  f.api.storage.flush = async () => {
    flushes++
    if (fail) { fail = false; throw new Error('fixture flush failure') }
    for (const [key, value] of queued) f.values.set(key, value)
    queued.clear()
  }
  f.offer(legacy([record('flush-retry')]))
  const controller = f.controller()
  await assert.rejects(controller.get(), /flush failure/)
  assert.equal(f.values.has(STORE), false)
  assert.equal((await controller.get()).records.length, 1)
  assert.equal(f.values.get(STORE).legacySourceImported, true)
  assert.equal(flushes, 2)
  assert.equal(f.state.starts, 1)
})

test('older hosts without commit or flush retain the ordered bank-then-head compatibility path', async () => {
  const f = fixture(), written = [], set = f.api.storage.set
  delete f.api.storage.commit
  f.api.storage.set = async (key, value) => { written.push(key); await set(key, value) }
  f.offer(legacy([record('compatibility')]))
  assert.equal((await f.controller().get()).records.length, 1)
  assert.deepEqual(written, [`${STORE}.a.0`, STORE])
})
