import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(packageRoot, '..', '..')
const output = mkdtempSync(join(tmpdir(), 'enest-ai-migration-code-'))
after(() => rmSync(output, { recursive: true, force: true }))
await build({ entryPoints: [join(packageRoot, 'src/service.ts'), join(packageRoot, 'src/worker.ts')], outdir: output, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }, logLevel: 'silent' })
const { createAgentConfigService, mergeJsonConfig, mergeTomlConfig, mergeYamlConfig } = await import(pathToFileURL(join(output, 'service.mjs')))
const { createAgentBackend } = await import(pathToFileURL(join(output, 'worker.mjs')))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'enest-ai-migration-data-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home'), appDataPath = join(root, 'state', 'data'), stageRoot = join(root, 'stages')
  for (const path of [home, appDataPath, stageRoot]) mkdirSync(path, { recursive: true })
  const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
  const api = createAgentConfigService({ homePath: home, appDataPath })
  return { root, home, appDataPath, stageRoot, put, api, backups: join(root, 'state', 'agent-config-backups') }
}

const DEFER = Symbol('defer')
class Port extends EventEmitter {
  messages = []
  waiting = new Map()
  sequence = 0
  control = () => true
  postMessage(message) {
    this.messages.push(message)
    if (message.type === 'host.request') {
      let result
      try { result = this.control(message) } catch (error) { queueMicrotask(() => this.respond(message.id, false, error.message)); return }
      if (result !== DEFER) queueMicrotask(() => this.respond(message.id, true, result))
    } else if (this.waiting.has(message.id)) {
      const waiter = this.waiting.get(message.id)
      this.waiting.delete(message.id)
      if (message.ok) waiter.resolve(message.data)
      else waiter.reject(new Error(message.error))
    }
  }
  respond(id, ok, value) { this.emit('message', { data: { type: 'host.response', id, ok, ...(ok ? { data: value } : { error: value }) } }) }
  call(method, input, pluginId = this.pluginId) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.emit('message', { data: { id, pluginId, method, args: input === undefined ? [] : [input] } })
    })
  }
}
function worker(t, mode = 'config', options = {}) {
  const f = fixture(t), port = new Port()
  port.pluginId = `com.github.eNest.${mode === 'pets' ? 'codex-pets' : 'ccswitch'}`
  const backend = createAgentBackend({ pluginId: port.pluginId, mode, port, homePath: f.home, stageRoot: f.stageRoot, ...options })
  t.after(() => backend.shutdown())
  const init = { type: 'init', pluginId: port.pluginId, generation: 1, wcId: 7, context: { protocolVersion: 1, appDataPath: f.appDataPath, packagePath: f.root, appExecPath: join(f.root, 'eNest') } }
  port.emit('message', { data: init })
  return { ...f, port, backend, init }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('ten application adapters and JSON/TOML/YAML merges stay plugin-owned', t => {
  const f = fixture(t)
  assert.equal(f.api.adapters.length, 10)
  assert.deepEqual(f.api.agentApps().map(item => item.app), ['claude-code', 'claude-desktop', 'codex', 'gemini-cli', 'grok-build', 'opencode', 'openclaw', 'hermes', 'pi', 'minimax-code'])
  assert.deepEqual(JSON.parse(mergeJsonConfig('{"keep":1,"model":"old"}', { model: 'new' })), { keep: 1, model: 'new' })
  const toml = mergeTomlConfig('# fixture\nmodel = "old"\n[untouched]\nx = 1\n', { model: 'new' })
  assert.match(toml, /# fixture/); assert.match(toml, /model = "new"/); assert.match(toml, /\[untouched\]\nx = 1/)
  const yaml = mergeYamlConfig('# fixture\nmodel: old\nkeep: yes\n', { model: 'new' })
  assert.match(yaml, /# fixture/); assert.match(yaml, /model: new/); assert.match(yaml, /keep: yes/)
  assert.throws(() => f.api.agentRead('test', '../../outside'), /unknown app/)
})

test('legacy backup directory/IDs and safety snapshots survive migration', t => {
  const f = fixture(t), file = join(f.home, '.codex/config.toml')
  f.put(file, 'model = "before"\n')
  const result = f.api.agentWrite('test', { app: 'codex', changes: { model: 'after' }, confirmed: true })
  assert.equal(readFileSync(join(f.backups, 'codex', result.backupId, 'main.toml'), 'utf8'), 'model = "before"\n')
  const legacy = '2026-01-02T03.04.05.006Z'
  f.put(join(f.backups, 'codex', legacy, 'main.toml'), 'model = "legacy"\n')
  assert.equal(f.api.agentBackups('test', 'codex').find(item => item.id === legacy).createdAt, Date.parse('2026-01-02T03:04:05.006Z'))
  f.api.agentRestore('test', { app: 'codex', id: legacy, confirmed: true })
  assert.match(readFileSync(file, 'utf8'), /legacy/)
  const snapshots = f.api.agentBackups('test', 'codex').filter(item => item.id !== legacy && item.id !== result.backupId)
  assert.equal(snapshots.length, 1)
  assert.match(readFileSync(join(f.backups, 'codex', snapshots[0].id, 'main.toml'), 'utf8'), /after/)
  assert.throws(() => f.api.agentWrite('test', { app: 'codex', changes: { $file: '../auth.json', key: 'fixture' }, confirmed: true }), /whitelist/)
})

test('config, session, assets and backups reject symlinks without partial restore', t => {
  const f = fixture(t), config = join(f.home, '.codex/config.toml'), outside = join(f.root, 'outside')
  f.put(config, 'model = "current"\n'); f.put(outside, 'fixture outside')
  symlinkSync(outside, join(f.home, '.codex/auth.json'))
  assert.throws(() => f.api.agentRead('test', 'codex'), /Symbolic/)
  const legacy = '2026-01-02T03.04.05.006Z'
  f.put(join(f.backups, 'codex', legacy, 'main.toml'), 'model = "restore"\n')
  f.put(join(f.backups, 'codex', legacy, 'auth.json'), '{}')
  assert.throws(() => f.api.agentRestore('test', { app: 'codex', id: legacy, confirmed: true }), /Symbolic/)
  assert.match(readFileSync(config, 'utf8'), /current/)
  mkdirSync(join(f.home, '.codex/sessions'), { recursive: true })
  symlinkSync(outside, join(f.home, '.codex/sessions/bad.jsonl'))
  assert.throws(() => f.api.agentSessionsRead('test', { app: 'codex', file: 'bad.jsonl' }), /Symbolic/)
  assert.equal(f.api.agentSessionsList('test', 'codex')[0].files.length, 0)
  mkdirSync(join(f.home, '.codex/pets'), { recursive: true })
  symlinkSync(f.root, join(f.home, '.codex/pets/escape'))
  assert.throws(() => f.api.writeStagedAssets('codex', [{ path: 'pets/escape/new', data: Buffer.from('x') }], true), /Symbolic/)
  assert.throws(() => f.api.agentDeleteAssets('test', { app: 'codex', paths: ['pets/escape'], confirmed: true }), /Symbolic/)
  assert.equal(readFileSync(outside, 'utf8'), 'fixture outside')
})

test('session byte and path whitelists, asset quotas and nested-delete preflight are preserved', t => {
  const f = fixture(t)
  f.put(join(f.home, '.codex/sessions/a.jsonl'), '{"fixture":1}\n'.repeat(60000))
  const data = f.api.agentSessionsRead('test', { app: 'codex', file: 'a.jsonl', maxBytes: 9 * 1024 * 1024 })
  assert.equal(data.readBytes, 512 * 1024); assert.equal(data.truncated, true)
  for (const file of ['../config.toml', '/a.jsonl', 'a%2Fb.jsonl', 'a\\b.jsonl', 'a.txt']) assert.throws(() => f.api.agentSessionsRead('test', { app: 'codex', file }))
  for (const path of ['pets', 'pets/../auth.json', 'pets/.hidden/x', 'pets/a/b.', 'auth.json']) {
    assert.throws(() => f.api.agentDeleteAssets('test', { app: 'codex', paths: [path], confirmed: true }))
  }
  assert.throws(() => f.api.writeStagedAssets('codex', [{ path: 'pets/a/large', data: Buffer.alloc(8 * 1024 * 1024 + 1) }], true), /size/)
  f.put(join(f.home, '.codex/pets/safe/manifest.json'), '{}')
  symlinkSync(f.root, join(f.home, '.codex/pets/safe/linked'))
  assert.throws(() => f.api.agentDeleteAssets('test', { app: 'codex', paths: ['pets/safe'], confirmed: true }), /Symbolic/)
  assert.equal(existsSync(join(f.home, '.codex/pets/safe/manifest.json')), true)
})

test('renderer confirmed cannot bypass a false/failed native confirmation', async t => {
  const f = worker(t), file = join(f.home, '.codex/config.toml')
  f.put(file, 'model = "before"\n')
  f.port.control = request => request.method === 'dialog.confirm' ? false : undefined
  await assert.rejects(f.port.call('write', { app: 'codex', changes: { model: 'after' }, confirmed: true }), /cancelled/)
  f.port.control = () => { throw new Error('fixture stale scope') }
  await assert.rejects(f.port.call('write', { app: 'codex', changes: { model: 'after' }, confirmed: true }), /stale scope/)
  assert.equal(readFileSync(file, 'utf8'), 'model = "before"\n')
  assert.equal(existsSync(f.backups), false)
  f.port.control = () => true
  await f.port.call('write', { app: 'codex', changes: { model: 'after' } })
  assert.match(readFileSync(file, 'utf8'), /after/)
  assert.ok(f.port.messages.filter(item => item.method === 'dialog.confirm').every(item => !JSON.stringify(item.params).includes('before')))
})

test('saved provider refs resolve after native confirmation for only three existing key targets', async t => {
  const f = worker(t)
  const secret = 'fixture-private-provider-key'
  f.port.control = request => request.method === 'secret.resolve' ? secret : true
  const targets = [
    { app: 'claude-code', file: '.claude/settings.json', changes: { env: { KEEP: 'fixture' } }, key: 'ANTHROPIC_AUTH_TOKEN' },
    { app: 'gemini-cli', file: '.gemini/settings.json', changes: { env: {} }, key: 'GOOGLE_API_KEY' },
    { app: 'codex', file: '.codex/auth.json', changes: { $file: 'auth.json' }, key: 'OPENAI_API_KEY' }
  ]
  for (const target of targets) {
    f.put(join(f.home, target.file), '{"untouched":true}')
    const response = await f.port.call('write', { app: target.app, changes: target.changes, secretRef: 'provider-ref' })
    assert.ok(!JSON.stringify(response).includes(secret))
    const config = JSON.parse(readFileSync(join(f.home, target.file), 'utf8'))
    assert.equal(config.untouched, true)
    assert.equal((target.app === 'codex' ? config : config.env)[target.key], secret)
  }
  assert.deepEqual(f.port.messages.filter(item => item.type === 'host.request').map(item => item.method), ['dialog.confirm', 'secret.resolve', 'dialog.confirm', 'secret.resolve', 'dialog.confirm', 'secret.resolve'])
  assert.ok(f.port.messages.every(item => !JSON.stringify(item).includes(secret)))
  await assert.rejects(f.port.call('write', { app: 'opencode', changes: { model: 'fixture' }, secretRef: 'provider-ref' }), /target/)
  await assert.rejects(f.port.call('write', { app: 'codex', changes: { model: 'fixture' }, secretRef: 'provider-ref' }), /target/)
  const before = f.port.messages.filter(item => item.method === 'secret.resolve').length
  f.port.control = () => false
  await assert.rejects(f.port.call('write', { app: 'claude-code', changes: { env: {} }, secretRef: 'provider-ref', confirmed: true }), /cancelled/)
  assert.equal(f.port.messages.filter(item => item.method === 'secret.resolve').length, before)
})

test('credential resolution failures and config parser errors never reflect vault values', async t => {
  const f = worker(t), secret = 'fixture-private-provider-key'
  f.port.control = request => { if (request.method === 'secret.resolve') throw new Error(secret); return true }
  await assert.rejects(f.port.call('write', { app: 'codex', changes: { $file: 'auth.json' }, secretRef: 'provider-ref' }), error => /resolve/.test(error.message) && !error.message.includes(secret))
  f.put(join(f.home, '.codex/auth.json'), `invalid-json-${secret}`)
  f.port.control = request => request.method === 'secret.resolve' ? secret : true
  await assert.rejects(f.port.call('write', { app: 'codex', changes: { $file: 'auth.json' }, secretRef: 'provider-ref' }), error => /configuration write failed/.test(error.message) && !error.message.includes(secret))
  assert.equal(readFileSync(join(f.home, '.codex/auth.json'), 'utf8'), `invalid-json-${secret}`)
  assert.ok(f.port.messages.every(item => !JSON.stringify(item).includes(secret)))
})

test('protocol owner, single initialization and mode boundaries fail closed', async t => {
  const f = worker(t, 'pets')
  assert.deepEqual((await f.port.call('apps')).map(app => app.app), ['codex'])
  await assert.rejects(f.port.call('assets.list', { app: 'codex' }, 'other.plugin'), /owner/)
  await assert.rejects(f.port.call('read', { app: 'codex' }), /Unsupported/)
  f.port.emit('message', { data: f.init })
  assert.equal(f.backend.state.closed, true)
  await assert.rejects(f.port.call('apps'), /repeatable/)
  const bad = worker(t)
  bad.backend.shutdown()
  const port = new Port(), rejected = createAgentBackend({ pluginId: bad.port.pluginId, mode: 'config', port, homePath: bad.home })
  port.emit('message', { data: { ...bad.init, context: { ...bad.init.context, protocolVersion: 0 } } })
  assert.equal(rejected.state.closed, true)
})

test('a file larger than 4 MiB commits in bounded chunks and is cleaned up', async t => {
  const f = worker(t, 'pets')
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 19, 87)
  const { stageId, chunkBytes } = await f.port.call('assets.stage', { app: 'codex', assets: [{ path: 'pets/fixture/spritesheet.webp', bytes: bytes.length }] })
  assert.equal(chunkBytes, 256 * 1024)
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) await f.port.call('assets.chunk', { stageId, index: 0, offset, contentBase64: bytes.subarray(offset, offset + chunkBytes).toString('base64') })
  await f.port.call('assets.commit', { stageId })
  assert.deepEqual(readFileSync(join(f.home, '.codex/pets/fixture/spritesheet.webp')), bytes)
  assert.deepEqual(readdirSync(f.stageRoot), [])
  assert.equal(f.backend.state.reservedBytes, 0)
  assert.equal(f.port.messages.filter(item => item.method === 'activity.release').length, 1)
  assert.ok(f.port.messages.every(message => Buffer.byteLength(JSON.stringify(message)) < 4 * 1024 * 1024))
})

test('asset quotas, offsets, early commit and denied commit cannot mutate targets', async t => {
  const f = worker(t, 'pets')
  await assert.rejects(f.port.call('assets.stage', { app: 'codex', assets: [{ path: 'pets/a/x', bytes: 8 * 1024 * 1024 + 1 }] }), /8 MiB/)
  const { stageId } = await f.port.call('assets.stage', { app: 'codex', assets: [{ path: 'pets/a/x', bytes: 2 }] })
  await assert.rejects(f.port.call('assets.chunk', { stageId, index: 0, offset: 1, contentBase64: 'eA==' }), /offset/)
  await assert.rejects(f.port.call('assets.commit', { stageId }), /incomplete/)
  await f.port.call('assets.chunk', { stageId, index: 0, offset: 0, contentBase64: 'eHg=' })
  f.port.control = request => request.method === 'dialog.confirm' ? false : undefined
  await assert.rejects(f.port.call('assets.commit', { stageId }), /cancelled/)
  assert.equal(existsSync(join(f.home, '.codex/pets/a/x')), false)
  assert.equal(f.backend.state.stages, 0)
  assert.deepEqual(readdirSync(f.stageRoot), [])
})

test('discard, idle expiry and shutdown release temporary files and activity', async t => {
  const f = worker(t, 'pets', { stageTtlMs: 20 })
  const begin = () => f.port.call('assets.stage', { app: 'codex', assets: [{ path: 'pets/a/x', bytes: 1 }] })
  const first = await begin()
  await f.port.call('assets.discard', first)
  await begin()
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(f.backend.state.stages, 0)
  const last = await begin()
  await f.port.call('assets.chunk', { ...last, index: 0, offset: 0, contentBase64: 'eA==' })
  f.port.control = request => request.method === 'dialog.confirm' ? DEFER : undefined
  f.port.emit('message', { data: { id: 500, pluginId: f.port.pluginId, method: 'assets.commit', args: [last] } })
  await tick()
  const confirmation = f.port.messages.find(item => item.method === 'dialog.confirm')
  f.backend.shutdown()
  f.port.respond(confirmation.id, true, true)
  await tick()
  assert.equal(existsSync(join(f.home, '.codex/pets/a/x')), false)
  assert.deepEqual(readdirSync(f.stageRoot), [])
  assert.equal(f.backend.state.reservedBytes, 0)
  assert.equal(f.port.messages.filter(item => item.method === 'activity.release').length, 3)
})

test('concurrent stage acquisition cannot evade its reservation budget', async t => {
  const f = worker(t, 'pets')
  f.port.control = () => DEFER
  for (const id of [400, 401]) f.port.emit('message', { data: { id, pluginId: f.port.pluginId, method: 'assets.stage', args: [{ app: 'codex', assets: [{ path: 'pets/a/x', bytes: 1 }] }] } })
  await assert.rejects(f.port.call('assets.stage', { app: 'codex', assets: [{ path: 'pets/a/x', bytes: 1 }] }), /budget/)
  f.backend.shutdown()
  await tick()
  assert.equal(f.backend.state.reservedBytes, 0)
  assert.deepEqual(readdirSync(f.stageRoot), [])
})

test('plugin packages declare explicit Node trust and bundle private shared source only', async () => {
  for (const [plugin, version] of [['ccswitch', '1.3.0'], ['codex-pets', '1.2.0']]) {
    const root = join(repo, 'plugins', plugin)
    const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'))
    assert.equal(manifest.version, version)
    assert.equal(manifest.engines.enest, '>=0.2.2')
    assert.ok(manifest.permissions.includes('backend.node'))
    assert.ok(!manifest.permissions.some(permission => permission.startsWith('config.agent')))
    assert.equal(manifest.backend.entry, 'backend/index.cjs')
    const result = await build({ entryPoints: [join(root, 'backend/index.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@enest/agent-config-backend/worker': join(packageRoot, 'src/worker.ts') }, metafile: true, logLevel: 'silent' })
    assert.ok(Object.keys(result.metafile.inputs).every(path => !path.includes('src/main/')))
    assert.ok(result.outputFiles[0].contents.byteLength < 100000)
  }
})

test('both frontends use backend calls and pet upload always discards its stage', async t => {
  const previous = globalThis.window
  t.after(() => { globalThis.window = previous })
  const calls = []
  globalThis.window = { enest: { backend: { call: async (method, args) => {
    calls.push({ method, args })
    if (method === 'assets.stage') return { stageId: 'fixture', chunkBytes: 256 * 1024 }
    if (method === 'assets.commit') throw new Error('fixture denied')
    return []
  } } } }
  const api = await import(pathToFileURL(join(repo, 'plugins/ccswitch/src/js/api.js')))
  await api.agentRead('codex'); await api.agentRestore('codex', 'fixture')
  assert.deepEqual(calls.slice(0, 2).map(call => call.method), ['read', 'restore'])
  const installer = await import(pathToFileURL(join(repo, 'plugins/codex-pets/src/js/installer.js')))
  await assert.rejects(installer.writeAssetChunks([{ path: 'pets/fixture/sheet', bytes: new Uint8Array(300000) }]), /denied/)
  assert.equal(calls.at(-1).method, 'assets.discard')
  const chunks = calls.filter(call => call.method === 'assets.chunk')
  assert.equal(chunks.length, 2)
  assert.ok(chunks.every(call => Buffer.byteLength(JSON.stringify(call.args)) < 4 * 1024 * 1024))
  const providers = await import(pathToFileURL(join(repo, 'plugins/ccswitch/src/js/providers.js')))
  calls.length = 0
  for (const app of ['claude-code', 'codex', 'gemini-cli']) await providers.applyProvider(app, { name: 'fixture', model: 'fixture', secretRef: 'saved-ref', plainSecret: 'must-not-be-sent' })
  const writes = calls.filter(call => call.method === 'write').map(call => call.args[0])
  assert.equal(writes.length, 4)
  assert.deepEqual(writes.filter(write => write.secretRef).map(write => write.app), ['claude-code', 'codex', 'gemini-cli'])
  assert.equal(writes.find(write => write.app === 'codex' && write.secretRef).changes.$file, 'auth.json')
  assert.ok(!JSON.stringify(calls).includes('must-not-be-sent'))
  assert.ok(!JSON.stringify(calls).includes('${SECRET}'))
})
