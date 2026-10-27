import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'

const source = readFileSync(new URL('../../src/js/api.js', import.meta.url), 'utf8')

function fixture(crypto) {
  let receiver, close
  const jobs = []
  const window = {
    enest: {
      on(_event, handler) { receiver = handler; return () => {} },
      backend: { async call(_method, [request, jobId]) {
        jobs.push(jobId)
        receiver({ event: 'dsh.job', data: { jobId, ok: true, data: request.action } })
        return { jobId }
      } }
    },
    addEventListener(_event, callback) { close = callback }
  }
  const math = Object.create(Math)
  math.random = () => { throw new Error('Weak randomness must not be used') }
  vm.runInNewContext(source, { window, crypto, isSecureContext: false, Math: math, setTimeout, clearTimeout })
  return { call: window.DshApi.call, jobs, close: () => close() }
}

test('custom-scheme insecure context uses 128 cryptographic bits and RFC4122 v4 job correlation IDs', async () => {
  const entropy = []
  const f = fixture({ getRandomValues(bytes) {
    assert.equal(bytes.byteLength, 16)
    webcrypto.getRandomValues(bytes)
    entropy.push(Array.from(bytes))
    return bytes
  } })
  try {
    const actions = Array.from({ length: 32 }, (_, index) => `fixture-${index}`)
    assert.deepEqual(await Promise.all(actions.map(action => f.call(action))), actions)
    assert.equal(new Set(f.jobs).size, actions.length)
    assert.equal(entropy.length, actions.length)
    for (let index = 0; index < f.jobs.length; index++) {
      const jobId = f.jobs[index], bytes = entropy[index]
      assert.match(jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      assert.equal(jobId.replaceAll('-', ''), Buffer.from(bytes).toString('hex'))
    }
  } finally { f.close() }
})

test('job correlation fails closed if cryptographic randomness is unavailable', () => {
  for (const crypto of [undefined, {}]) {
    const f = fixture(crypto)
    try {
      assert.throws(() => f.call('settings.get'), /Secure random generation is unavailable/)
      assert.equal(f.jobs.length, 0)
    } finally { f.close() }
  }
})
