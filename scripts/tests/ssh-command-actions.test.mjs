import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareCommandAction, createCommandActions } from '../../plugins/com.enest.ssh/src/js/commandActions.js'
import { decodeTerminalData } from '../../plugins/com.enest.ssh/src/js/terminalData.js'
import { isReservedSshShortcut, displaySshShortcut } from '../../plugins/com.enest.ssh/src/js/shortcutPolicy.js'

const prompt = text => ({ promptId: 3, revision: 5, text, cursor: text.length, cwd: '/srv/中文' })
function fixture() {
  let current = prompt('echo '), active
  const writes = [], errors = [], history = []
  const source = { sessionId: 'A', term: { readCommand: () => current, noteInput: () => { current = null }, focus() {}, invalidateCommand() { current = null } } }
  active = source
  const create = beforeExecute => createCommandActions({ getSession: () => active, send: async (id, data) => writes.push([id, data]), beforeExecute, onExecuted: text => history.push(text), onError: error => errors.push(error.message) })
  return { source, writes, errors, history, create, current: value => { current = value }, active: value => { active = value } }
}

test('selected command insertion and execution preserve Unicode and append exactly once', async () => {
  assert.equal(prepareCommandAction('echo value ', prompt('echo ')).payload, 'value ')
  const f = fixture(), actions = f.create(() => true)
  assert.equal(await actions.insert('echo "中文；：，😀"'), true)
  assert.deepEqual(f.writes, [['A', '"中文；：，😀"']]); assert.deepEqual(f.history, [])
  f.current(prompt('echo "中文；：，😀"')); assert.equal(await actions.execute('echo "中文；：，😀"'), true)
  assert.deepEqual(f.writes.at(-1), ['A', '\r']); assert.deepEqual(f.history, ['echo "中文；：，😀"'])
})
test('quick actions reject controls, untrusted prompts, pending echo and unrelated current input', () => {
  for (const text of ['echo a\necho b','echo a\recho b','echo \x1b[31m','echo \x9b31m']) assert.throws(() => prepareCommandAction(text, prompt('')), /换行或控制字符/)
  assert.throws(() => prepareCommandAction('echo a', null), /待回显/)
  assert.throws(() => prepareCommandAction('echo a', { ...prompt('echo a'), cursor: 2 }), /命令行末尾/)
  assert.throws(() => prepareCommandAction('echo a', prompt('rm ')), /已有内容/)
})
test('switching sessions during dangerous-command confirmation never redirects execution', async () => {
  const f = fixture(); let confirm
  const actions = f.create(() => new Promise(resolve => { confirm = resolve }))
  const pending = actions.execute('echo dangerous'); f.active({ sessionId: 'B', term: f.source.term }); confirm(true)
  assert.equal(await pending, false); assert.deepEqual(f.writes, []); assert.match(f.errors[0], /会话已变化/)
})
test('remote prompt changes or cancellation during confirmation keep the command untouched', async () => {
  for (const accept of [true, false]) {
    const f = fixture(); let confirm; const pending = f.create(() => new Promise(resolve => { confirm = resolve })).execute('echo danger')
    if (accept) f.current({ ...prompt('echo '), revision: 6 })
    confirm(accept); assert.equal(await pending, false); assert.deepEqual(f.writes, [])
  }
})
test('explicit history actions forward native sequences and never submit a command', async () => {
  const f = fixture(), actions = f.create()
  assert.equal(await actions.history(-1), true); f.current(prompt('echo recalled')); assert.equal(await actions.history(1), true)
  assert.deepEqual(f.writes, [['A','\x1b[A'],['A','\x1b[B']]); assert.deepEqual(f.history, [])
  assert.equal(await actions.history(-1), false)
})
test('binary UTF-8 output is decoded across arbitrary chunk boundaries per session', () => {
  const first = {}, second = {}, bytes = new TextEncoder().encode('中文😀，hello')
  let text = ''
  for (const value of bytes) text += decodeTerminalData(first, [value])
  assert.equal(text, '中文😀，hello'); assert.equal(decodeTerminalData(second, new TextEncoder().encode('另一台')), '另一台')
  assert.equal(decodeTerminalData(first, ' next'), ' next'); assert.equal(first.outputDecoder, null)
})
test('only completion commands may own their dedicated Alt bindings and labels use actual platform keys', () => {
  assert.equal(isReservedSshShortcut('Alt+Enter', true, 'completion-accept'), false)
  assert.equal(isReservedSshShortcut('Alt+Enter', true, 'execute-selection'), true)
  assert.equal(isReservedSshShortcut('Alt+ArrowUp', false, 'completion-previous'), false)
  assert.equal(displaySshShortcut('Mod+Shift+R', true), 'Command+Shift+R')
  assert.equal(displaySshShortcut('Alt+Enter', true), 'Option+Enter')
  assert.equal(displaySshShortcut('Mod+Shift+I', false), 'Ctrl+Shift+I')
})
