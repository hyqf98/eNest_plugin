import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, webcrypto } from 'node:crypto'
import vm from 'node:vm'
import { build } from 'esbuild'

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(backendRoot, '../../..')
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'enest-dsh-migration-')))
const bundle = join(fixtureRoot, 'backend.cjs')
const bootstrap = join(fixtureRoot, 'utility.cjs')
const owner = 'com.github.eNest.dsh'
after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

await build({ entryPoints: [join(backendRoot, 'index.ts')], outfile: bundle, bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', alias: { '@backend': backendRoot },
  external: ['js-yaml', 'undici', 'socks'], logLevel: 'silent' })
writeFileSync(bootstrap, `
const { EventEmitter } = require('node:events');
const port = new EventEmitter();
port.postMessage = message => process.send(message);
process.parentPort = port;
process.on('message', data => port.emit('message', { data }));
require(${JSON.stringify(bundle)});
`)

function syntheticRuntime(root) {
  const directory = join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(directory, 'lib'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-fixture' }))
  writeFileSync(join(directory, 'lib', 'bin.js'), `
if (process.argv.includes('--version')) { console.log('0.0.0-fixture'); process.exit(0); }
if (process.argv.includes('--port')) {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  const server = require('node:http').createServer((_request, response) => response.end('fixture'));
  server.listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port + '/?token=fixture'));
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
} else {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.method === 'shutdown') process.exit(0);
    const result = frame.method === 'initialize' ? { serverInfo: { name: 'fixture', version: '1' } } : { method: frame.method, params: frame.params };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
  });
}
`)
}

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(fixtureRoot, 'case-')))
  const packagePath = join(root, 'package'), appDataPath = join(root, 'data')
  mkdirSync(packagePath); mkdirSync(appDataPath)
  if (options.runtime) syntheticRuntime(packagePath)
  const messages = [], controls = [], activities = new Set(), tracked = new Set(), events = new EventEmitter()
  const child = fork(bootstrap, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {
    ...process.env, PATH: '', NODE_PATH: [join(repositoryRoot, 'node_modules'), join(repositoryRoot, '..', 'node_modules')].join(delimiter)
  } })
  let stderr = '', id = 0
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const exit = new Promise(resolveExit => child.once('exit', code => resolveExit(code)))
  const replyControl = (message, data) => child.connected && child.send({ type: 'host.response', id: message.id, ok: true, data })
  child.on('message', message => {
    messages.push(message)
    if (message.type === 'host.request') {
      controls.push(message)
      const { method, params } = message
      if (method === 'activity.acquire') activities.add(params.token)
      if (method === 'activity.release') activities.delete(params.token)
      if (method === 'process.track') tracked.add(params.pid)
      if (method === 'process.untrack') tracked.delete(params.pid)
      if (method !== 'endpoint.allow' || !options.holdEndpoint) replyControl(message, method === 'network.resolveProxy' ? { proxy: 'DIRECT' } : undefined)
    }
    events.emit('message')
  })
  function wait(predicate, timeout = 5000) {
    const found = () => messages.find(predicate)
    if (found()) return Promise.resolve(found())
    return new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => { events.off('message', check); reject(new Error(`fixture timeout: ${stderr}`)) }, timeout)
      const check = () => { const value = found(); if (value) { clearTimeout(timer); events.off('message', check); resolveWait(value) } }
      events.on('message', check)
    })
  }
  async function rpc(method, args, pluginId = owner) {
    const requestId = ++id
    child.send({ id: requestId, pluginId, method, args, proxy: {} })
    return wait(message => message.id === requestId && !message.type)
  }
  async function workbench(action, input = {}) {
    const jobId = randomUUID()
    const response = await rpc('workbench', [{ action, input }, jobId])
    if (!response.ok) throw new Error(response.error)
    assert.deepEqual(response.data, { jobId })
    const completed = await wait(message => message.event === 'dsh.job' && message.data.jobId === jobId)
    if (!completed.data.ok) throw new Error(completed.data.error)
    return completed.data.data
  }
  async function shutdown() {
    if (child.exitCode !== null) return
    child.send({ type: 'shutdown', reason: 'fixture complete', deadlineAt: Date.now() + 1500 })
    await wait(message => message.type === 'shutdown.complete')
    assert.equal(await exit, 0)
  }
  t.after(async () => {
    if (child.exitCode === null) {
      try { await shutdown() } catch { child.kill('SIGKILL') }
    }
    for (const pid of tracked) { try { process.kill(pid, 'SIGKILL') } catch { /* own fixture process already exited */ } }
  })
  child.send({ type: 'init', pluginId: owner, generation: 7, wcId: 19, context: {
    protocolVersion: 1, appDataPath, packagePath, appExecPath: process.execPath
  } })
  return { root, appDataPath, child, controls, activities, tracked, messages, wait, rpc, workbench, shutdown, replyControl }
}

test('native transport validates ownership and preserves profiles, sessions and backups under the supplied data root', async t => {
  const f = fixture(t)
  assert.match((await f.rpc('workbench', [{ action: 'settings.get' }, randomUUID()], 'com.other.plugin')).error, /owner mismatch/)
  assert.match((await f.rpc('unknown', [])).error, /invalid DSH backend request/)
  assert.match((await f.rpc('workbench', [{ action: 'arbitrary' }, randomUUID()])).error, /Unknown dsh workbench action/)
  assert.deepEqual(await f.workbench('settings.get'), { webProfile: 'web', sdkProfile: 'sdk', webPortPolicy: 'auto', webPort: 3000 })
  await f.workbench('profiles.create', { name: 'fixture-web', template: 'web' })
  const profile = await f.workbench('profiles.read', { name: 'fixture-web' })
  assert.ok(profile.bundles.includes('@deepseek-ai/dsh-web-app'))
  await f.workbench('profiles.update', { name: 'fixture-web', bundles: profile.bundles, patch: '[]\n', environment: { DEEPSEEK_API_KEY: 'fixture-only-secret' } })
  assert.equal((await f.workbench('profiles.read', { name: 'fixture-web' })).environment.DEEPSEEK_API_KEY, 'fixture-only-secret')
  assert.equal(JSON.stringify(await f.workbench('profiles.list')).includes('fixture-only-secret'), false)
  await f.workbench('settings.update', { webProfile: 'fixture-web' })
  assert.equal(JSON.parse(readFileSync(join(f.appDataPath, 'dsh-home', '.enest-workbench.json'), 'utf8')).webProfile, 'fixture-web')
  const sessionDir = join(f.appDataPath, 'dsh-home', 'sessions', 'fixture-session')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'session.jsonl'), JSON.stringify({ type: 'user/message', message: { content: [{ type: 'text', text: 'fixture session' }] } }) + '\n')
  assert.equal((await f.workbench('sessions.list'))[0].title, 'fixture session')
  assert.equal((await f.workbench('sessions.read', { sessionId: 'fixture-session' })).events.length, 1)
  await assert.rejects(f.workbench('sessions.read', { sessionId: '../escape' }), /sessionId/)
  const backup = await f.workbench('backup.create', { label: 'migration-fixture' })
  assert.ok((await f.workbench('backup.list')).some(entry => entry.backupId === backup.backupId))
  await f.workbench('backup.restore', { backupId: backup.backupId })
  assert.equal((await f.workbench('settings.get')).webProfile, 'fixture-web')
  await f.shutdown()
  assert.equal(f.activities.size, 0)
  assert.equal(f.tracked.size, 0)
})

test('Web readiness waits for a host endpoint grant and shutdown closes both real synthetic children', async t => {
  const f = fixture(t, { runtime: true, holdEndpoint: true })
  assert.equal((await f.workbench('runtime.detect')).version, '0.0.0-fixture')
  const web = await f.workbench('web.start')
  const grant = await f.wait(message => message.type === 'host.request' && message.method === 'endpoint.allow')
  assert.equal(grant.params.pid, web.pid)
  assert.ok(f.tracked.has(web.pid))
  assert.equal(f.messages.some(message => message.event === 'dsh.event' && message.data.type === 'web-ready'), false)
  f.replyControl(grant)
  await f.wait(message => message.event === 'dsh.event' && message.data.type === 'web-ready')
  const sdk = await f.workbench('sdk.start')
  assert.ok(f.tracked.has(sdk.pid))
  const response = await f.workbench('rpc.write', { method: 'session/prompt', params: { prompt: 'fixture only' } })
  assert.equal(response.method, 'session/prompt')
  await assert.rejects(f.workbench('rpc.call', { method: 'session/prompt', params: {} }), /rpc.call/)
  await f.shutdown()
  assert.equal(f.activities.size, 0)
  assert.equal(f.tracked.size, 0)
  assert.throws(() => process.kill(web.pid, 0), /ESRCH/)
  assert.throws(() => process.kill(sdk.pid, 0), /ESRCH/)
  assert.ok(f.controls.some(message => message.method === 'endpoint.revoke'))
})

test('frontend job facade accepts result-before-ack and releases event listeners on page close', async () => {
  let receiver, close, detached = false
  const api = {
    on(event, handler) { assert.equal(event, 'backend.event'); receiver = handler; return () => { detached = true } },
    backend: { async call(method, [request, jobId]) {
      assert.equal(method, 'workbench')
      if (request.action === 'denied') throw new Error('permission denied: backend.node')
      receiver({ event: 'dsh.job', data: { jobId, ok: true, data: { action: request.action } } })
      return { jobId }
    } }
  }
  const window = { enest: api, addEventListener(name, callback) { assert.equal(name, 'pagehide'); close = callback } }
  vm.runInNewContext(readFileSync(join(backendRoot, '../src/js/api.js'), 'utf8'), { window, crypto: webcrypto, setTimeout, clearTimeout })
  assert.equal((await window.DshApi.call('settings.get')).action, 'settings.get')
  await assert.rejects(window.DshApi.call('denied'), /backend.node/)
  let received = 0
  const unsubscribe = window.DshApi.onDshEvent(() => received++)
  receiver({ event: 'dsh.event', data: { type: 'web-ready' } })
  unsubscribe()
  receiver({ event: 'dsh.event', data: { type: 'web-ready' } })
  assert.equal(received, 1)
  close()
  assert.equal(detached, true)
})
