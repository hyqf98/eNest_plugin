import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { COMMAND_SCAN_COMMAND, pathContext, pathCandidate, commandNames, createRemoteCompletion, RemoteReadCache, mergeSuggestions } from '../../plugins/ssh/src/js/remoteCompletion.js'

const window = {}
new Function('window', readFileSync(new URL('../../plugins/ssh/src/js/commandCompletion.js', import.meta.url), 'utf8'))(window)
const engine = window.SshCommandCompletion
const preferences = engine.preferences({ remotePaths: true, remoteCommands: true })
const snapshot = (text, extra = {}) => ({ text, cursor: text.length, promptId: 1, revision: 1, cwd: '/home/developer', ...extra })
const create = options => createRemoteCompletion({ commandContext: engine.context, ...options })
const flush = () => new Promise(resolve => setImmediate(resolve))

test('remote command scanning is opt-in and all remote reads require a complete trusted line-end snapshot', async () => {
  let calls = 0
  const remote = create({ list: async () => { calls++; return [] }, exec: async () => { calls++; return { stdout: '', exitCode: 0 } } })
  assert.equal(engine.preferences().remotePaths, true)
  assert.equal(engine.preferences().remoteCommands, false)
  for (const value of [null, snapshot('cat /tmp/a', { cursor: 2 })]) assert.equal(remote.plan(value, preferences), null)
  assert.equal(remote.plan(snapshot('cat /tmp/a'), engine.preferences({ remotePaths: false })), null)
  assert.equal(remote.plan(snapshot('ne'), preferences).kind, 'commands')
  assert.equal(remote.plan(snapshot('sudo -u root ne'), preferences).kind, 'commands')
  await remote.load('a', null, preferences)
  assert.equal(calls, 0); remote.dispose()
})

test('path parsing preserves cwd, spaces, quoted paths and safe home-relative lookup', () => {
  assert.equal(pathContext('cat ./文', '/srv/a b').directory, '/srv/a b/./')
  assert.equal(pathContext('cat ~/文', '/srv').directory, './')
  for (const line of ['cat "~/文', "cat '~/文", 'cat \\~/文', "cat '~'/文"]) assert.equal(pathContext(line, '/srv').directory, '/srv/~/', line)
  assert.equal(pathContext('cat /tmp/文', '').directory, '/tmp/')
  assert.equal(pathContext("cat '/tmp/a b/文", '/srv').prefix, '文')
  assert.equal(pathContext('cat "a\\$b/文', '/srv').directory, '/srv/a$b/')
  for (const text of ['cat $HOME/a', 'cat $(pwd)/a', 'cat `pwd`/a', 'cat "${HOME}/a', 'cat ~other/a', 'cat a*', 'cat a\\', 'cat > a', 'cat # comment', 'cat a\n']) assert.equal(pathContext(text, '/srv'), null, text)
  assert.equal(pathContext('cat relative', ''), null)
})

test('path insertion is append-only and shell-literal for Chinese, spaces, apostrophes and metacharacters', () => {
  for (const [line, name] of [
    ['cat /tmp/报', '报告 1.txt'],
    ["cat '/tmp/报", "报告 O'海.txt"],
    ['cat "/tmp/报', '报告 "$`\\.txt'],
    ['cat /tmp/报', '报告;$(printf INJECTED)&*.txt'],
    ["cat '/tmp/报'", '报告 1.txt']
  ]) {
    const item = pathCandidate(pathContext(line, '/srv'), { name, type: 'file' })
    assert.ok(item?.fullCommand.startsWith(line), line)
    assert.ok(!/[\r\n\x00]/.test(item.insertText))
    // Execute no candidate: `set --` only parses the literal argument, including attack-shaped names.
    const parsed = spawnSync('/bin/sh', ['-c', `set -- ${item.fullCommand}; printf '%s\\0' "$@"`], { encoding: 'utf8' })
    assert.equal(parsed.status, 0, parsed.stderr)
    assert.deepEqual(parsed.stdout.split('\0').filter(Boolean), ['cat', '/tmp/' + name])
  }
})

test('directory candidates close quotes safely and continue by concatenating literal suffixes', () => {
  const context = pathContext("cd '/tmp/pro", '/srv')
  const item = pathCandidate(context, { name: 'project space', type: 'dir' })
  assert.equal(item.fullCommand, "cd '/tmp/project space/'")
  assert.equal(pathContext(item.fullCommand, '/srv').directory, '/tmp/project space/')
  assert.equal(pathCandidate(pathContext(item.fullCommand, '/srv'), { name: 'child space', type: 'dir' }).fullCommand, "cd '/tmp/project space/'child\\ space/")
  assert.equal(pathCandidate(context, { name: 'project.txt', type: 'file' }), null)
  for (const name of ['pro\nattack', 'pro\x1battack', 'pro/attack', '.', '..']) assert.equal(pathCandidate(context, { name, type: 'dir' }), null)
  assert.equal(pathCandidate(pathContext('cat /tmp/', '/srv'), { name: '.hidden', type: 'file' }), null)
  assert.ok(pathCandidate(pathContext('cat /tmp/.', '/srv'), { name: '.hidden', type: 'file' }))
})

test('remote command discovery uses only a fixed bounded script, independent from typed input', async () => {
  const calls = []
  const remote = create({ exec: async input => { calls.push(input); return { stdout: 'nebula\0node\0nebula\0bad\nname\0a/b\0', exitCode: 0 } } })
  const result = await remote.load('server-a', snapshot('ne'), preferences)
  assert.deepEqual(result.items.map(item => item.fullCommand), ['nebula'])
  assert.equal(result.items[0].detail, '远端 PATH · 独立会话')
  assert.equal(calls[0].command, COMMAND_SCAN_COMMAND)
  assert.equal(calls[0].timeoutMs, 4500)
  assert.match(COMMAND_SCAN_COMMAND, /-le 32/)
  assert.match(COMMAND_SCAN_COMMAND, /-lt 2048/)
  assert.doesNotMatch(COMMAND_SCAN_COMMAND, /source|\.bashrc|\.zshrc|compgen/)
  await remote.load('server-a', snapshot('no'), preferences)
  assert.equal(calls.length, 1)
  await remote.load('server-b', snapshot('no'), preferences)
  assert.equal(calls.length, 2)
  assert.deepEqual(commandNames('a\0a\0中文\0bad\x1bname\0a/b\0'), ['a', '中文'])
  remote.dispose()
})

test('directory reads are scoped to session/directory, bounded, cached and merged without duplicates', async () => {
  const calls = [], entries = [{ name: 'report.txt', type: 'file' }, { name: 'reports', type: 'dir' }]
  const remote = create({ list: async input => { calls.push(input); return entries } })
  const first = await remote.load('a', snapshot('cat /tmp/re'), preferences)
  assert.deepEqual(first.items.map(item => item.label), ['reports/', 'report.txt'])
  await remote.load('a', snapshot('cat /tmp/rep'), preferences)
  assert.equal(calls.length, 1)
  await remote.load('a', snapshot('cat /other/re'), preferences)
  await remote.load('b', snapshot('cat /tmp/re'), preferences)
  assert.equal(calls.length, 3)
  const merged = mergeSuggestions([{ fullCommand: 'docker', rank: 10 }, { fullCommand: 'dockyard', rank: 15 }], [{ fullCommand: 'docker', rank: 8, source: 'remote-command' }], 8)
  assert.equal(merged.length, 2); assert.equal(merged[0].source, 'remote-command')
  remote.dispose()
})

test('path input stays data in SFTP and cache expiry/candidate limits are enforced', async () => {
  let time = 100, calls = 0
  const cache = new RemoteReadCache({ now: () => time }), reads = []
  const remote = create({ cache, list: async input => {
    calls++; reads.push(input)
    return Array.from({ length: 5000 }, (_, index) => ({ name: `report-${index}.txt`, type: 'file' }))
  }, exec: async () => { throw new Error('Path reads must not execute any shell request') } })
  const input = snapshot("cat '/tmp/$(printf INJECTED)/re")
  const first = await remote.load('a', input, preferences)
  assert.equal(reads[0].path, '/tmp/$(printf INJECTED)/')
  assert.equal(first.items.length, 40); assert.match(first.status, /4096/)
  await remote.load('a', input, preferences); assert.equal(calls, 1)
  time += 3001; await remote.load('a', input, preferences); assert.equal(calls, 2)
  remote.dispose()
})

test('cache coalesces reads but aborting one waiter does not cancel another waiter', async () => {
  const cache = new RemoteReadCache(), controller = new AbortController()
  let release, calls = 0
  const read = () => { calls++; return new Promise(resolve => { release = resolve }) }
  const one = cache.read('a', 3000, read, controller.signal)
  const two = cache.read('a', 3000, read)
  await flush(); controller.abort()
  await assert.rejects(one, { name: 'AbortError' })
  release(['result']); assert.deepEqual(await two, ['result']); assert.equal(calls, 1)
  cache.dispose()
})

test('aborted queued requests never reach the server and physical concurrency stays bounded', async () => {
  const cache = new RemoteReadCache(), releases = [], calls = []
  const loader = id => () => { calls.push(id); return new Promise(resolve => releases.push(resolve)) }
  const a = cache.read('a', 3000, loader('a')), b = cache.read('b', 3000, loader('b'))
  const abort = new AbortController(), c = cache.read('c', 3000, loader('c'), abort.signal)
  await flush(); abort.abort(); await assert.rejects(c, { name: 'AbortError' })
  assert.deepEqual(calls, ['a', 'b'])
  releases.forEach(release => release([])); await Promise.all([a, b]); await flush()
  assert.deepEqual(calls, ['a', 'b']); cache.dispose()
})

test('cache invalidation discards stale completions, and failure/timeout leaves local fallback available', async () => {
  let release, calls = 0
  const cache = new RemoteReadCache({ waitMs: 30 })
  const pending = cache.read('a', 3000, () => new Promise(resolve => { release = resolve }))
  await flush(); cache.invalidate(); await assert.rejects(pending, { name: 'AbortError' }); release(['old']); await flush()
  assert.deepEqual(await cache.read('a', 3000, async () => { calls++; return ['new'] }), ['new']); assert.equal(calls, 1)
  const timed = cache.read('b', 3000, () => new Promise(resolve => { release = resolve }))
  await assert.rejects(timed, /超时/); release([]); cache.dispose()
  const remote = create({ list: async () => { throw new Error('permission denied') } })
  const result = await remote.load('a', snapshot('cat /tmp/'), preferences)
  assert.deepEqual(result.items, []); assert.match(result.status, /本地提示仍可使用/); remote.dispose()
})
