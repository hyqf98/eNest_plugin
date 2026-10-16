import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const root = new URL('../../plugins/ssh/src/js/', import.meta.url)
const window = {}
for (const file of ['dict.js', 'commandCompletion.js']) new Function('window', readFileSync(new URL(file, root), 'utf8'))(window)
const engine = window.SshCommandCompletion
const suggest = (line, sources = {}) => engine.suggest(line, { force: true, ...sources })
const names = items => items.map(item => item.label)

test('command suggestions preserve spaces and append only the missing case-sensitive suffix', () => {
  const result = suggest('  doc')
  assert.equal(result[0].label, 'docker')
  assert.equal(result[0].fullCommand, '  docker')
  assert.equal(result[0].insertText, 'ker')
  assert.equal(suggest('DOC').length, 0)
  assert.ok(names(suggest('docker ')).includes('logs'))
  assert.ok(names(suggest('docker l')).includes('logs'))
})

test('nested subcommands and their own option grammar do not duplicate the command', () => {
  assert.deepEqual(names(suggest('docker compose u')), ['up'])
  assert.deepEqual(names(suggest('docker compose up -')), ['-d', '--build'])
  assert.ok(names(suggest('docker logs -')).includes('--tail'))
  assert.ok(!names(suggest('docker logs -')).includes('ps'))
  assert.equal(suggest('docker logs --t')[0].fullCommand, 'docker logs --tail')
  assert.ok(names(suggest('kubectl get ')).includes('pods'))
  assert.deepEqual(names(suggest('kubectl get pods -o ')), ['wide', 'yaml', 'json', 'name'])
})

test('option values are scoped and an unknown free-form value does not suggest unrelated flags', () => {
  assert.deepEqual(names(suggest('curl -X P')), ['POST', 'PUT', 'PATCH'])
  assert.deepEqual(suggest('docker logs --tail '), [])
  assert.ok(!names(suggest('ls -l -')).includes('-l'))
  assert.deepEqual(suggest('journalctl -u '), [])
  assert.deepEqual(suggest('ls -- -'), [])
  assert.deepEqual(names(suggest('kubectl -n default get p')), ['pods'])
  assert.deepEqual(names(suggest('docker --context production compose u')), ['up'])
})

test('wrappers, assignments and pipeline segments keep their original prefix', () => {
  assert.equal(suggest('sudo -u root dock')[0].fullCommand, 'sudo -u root docker')
  assert.equal(suggest('LANG=C git sta')[0].fullCommand, 'LANG=C git status')
  assert.equal(suggest('env LANG=C git sta')[0].fullCommand, 'env LANG=C git status')
  assert.equal(suggest('ls | gre')[0].fullCommand, 'ls | grep')
  assert.deepEqual(suggest('sudo -u '), [])
})

test('uncertain shell syntax, paths, substitutions, comments and multiline input are not guessed', () => {
  for (const input of ['echo "doc', "echo 'doc", 'echo $(doc', 'echo `doc', 'ls > doc', 'ls # doc', 'docker \\', 'ls ./', 'doc\n', 'doc\x1b']) assert.deepEqual(suggest(input), [], input)
})

test('history stays on the current connection and multiline or placeholder snippets never insert', () => {
  const sources = { profileId: 'a', snippets: [{ command: 'docker ps\nwhoami' }, { command: 'docker logs <container>' }, { command: 'docker ps', title: '容器列表' }], history: [{ profileId: 'b', command: 'docker logs secret' }, { profileId: 'a', command: 'docker logs app', ts: 2 }, { profileId: 'a', command: 'docker logs older', ts: 1 }] }
  const result = suggest('docker ', sources)
  assert.ok(result.some(item => item.fullCommand === 'docker ps'))
  assert.ok(!result.some(item => /secret|whoami|<container>/.test(item.fullCommand)))
  const history = suggest('docker logs ', sources).filter(item => item.kind === 'history')
  assert.deepEqual(history.map(item => item.fullCommand), ['docker logs app', 'docker logs older'])
})

test('custom commands and settings apply without changing the dictionary and do not inject controls', () => {
  const prefs = { commands: false, options: false, snippets: false, history: false, userCommands: [{ command: 'dockyard status', description: '查看部署' }, { command: 'doc\rwhoami' }] }
  assert.deepEqual(names(suggest('doc', { preferences: prefs })), ['dockyard status'])
  assert.deepEqual(suggest('doc', { preferences: { enabled: false } }), [])
  assert.deepEqual(engine.suggest('d', { preferences: { minChars: 2 } }), [])
  assert.deepEqual(engine.suggest('docker', { preferences: { autoSuggest: false } }), [])
  assert.equal(engine.preferences({ maxItems: 99 }).maxItems, 12)
})

test('acceptance requires the exact prompt, revision, cursor, directory and line snapshot', () => {
  const original = { promptId: 1, revision: 4, cursor: 3, text: 'doc', cwd: '/srv' }
  const item = suggest('doc')[0]
  assert.equal(engine.suffixFor(item, original, { ...original }), 'ker')
  for (const changed of [{ revision: 5 }, { promptId: 2 }, { cwd: '/tmp' }, { text: 'do' }, { cursor: 2 }]) assert.equal(engine.suffixFor(item, original, { ...original, ...changed }), null)
  assert.equal(engine.suffixFor({ fullCommand: 'docker\r' }, original, original), null)
  assert.equal(engine.suffixFor({ fullCommand: 'git' }, original, original), null)
})

function terminalFixture() {
  const stateEvents = [], listeners = new Map()
  class FakeTerminal {
    constructor() {
      this.cols = 80; this.rows = 24; this.line = 'fixture$ '; this.callbacks = []
      this.buffer = { active: { type: 'normal', baseY: 0, cursorY: 0, cursorX: 9, viewportY: 0, getLine: index => index === 0 ? { isWrapped: false, translateToString: (trim, start, end) => { const value = this.line.padEnd(this.cols).slice(start, end); return trim ? value.trimEnd() : value } } : undefined } }
      this.parser = { registerOscHandler: (id, fn) => listeners.set(id, fn) }
    }
    open() {} loadAddon() {} onData(fn) { this.data = fn } onSelectionChange() {} onScroll() {} attachCustomKeyEventHandler() {}
    write(data, callback) { if (callback) this.callbacks.push(callback) }
    setCommand(text) { this.line = 'fixture$ ' + text; this.buffer.active.cursorX = 9 + text.length }
    flush() { this.callbacks.splice(0).forEach(fn => fn()) }
    dispose() {} focus() {}
  }
  const global = { Terminal: FakeTerminal, SearchAddon: class {}, addEventListener() {}, removeEventListener() {} }
  const store = { state: { ui: {} } }
  const source = readFileSync(new URL('term.js', root), 'utf8')
  new Function('window', 'document', 'SshStore', 'ResizeObserver', 'requestAnimationFrame', source)(global, { documentElement: {} }, store, class { observe() {} disconnect() {} }, () => {})
  const container = { innerHTML: '', addEventListener() {}, removeEventListener() {}, querySelector() {} }
  const term = global.SshTerm.createTerminal(container, { onCommandState: event => stateEvents.push(event) })
  listeners.get(133)('B')
  return { term, raw: term.raw, listeners, stateEvents }
}

test('terminal snapshots preserve the actual trailing space and require an integrated prompt', () => {
  const { term, raw, listeners } = terminalFixture()
  raw.setCommand('docker ')
  assert.equal(term.readCommand().text, 'docker ')
  assert.equal(term.readCommand().cursor, 7)
  listeners.get(133)('C')
  assert.equal(term.readCommand(), null)
})

test('unacknowledged input, parse queues and rapid echo prevent stale acceptance', () => {
  const { term, raw } = terminalFixture()
  raw.setCommand('doc'); const previous = term.readCommand()
  term.noteInput('k'); term.noteInput('e')
  assert.equal(term.readCommand(), null)
  term.write('echo-one'); raw.setCommand('dock'); raw.flush()
  assert.equal(term.readCommand(), null)
  term.write('echo-two'); raw.setCommand('docke')
  assert.equal(term.readCommand(), null)
  raw.flush()
  assert.equal(term.readCommand().text, 'docke')
  assert.notEqual(term.readCommand().revision, previous.revision)
})

test('submission, interrupt, alternate screen and a navigation race retire command scope', () => {
  for (const data of ['\r', '\n', '\x03', 'doc\n']) {
    const { term, raw } = terminalFixture(); raw.setCommand('doc'); term.noteInput(data); assert.equal(term.readCommand(), null)
  }
  const { term, raw } = terminalFixture(); raw.setCommand('doc'); raw.buffer.active.type = 'alternate'; assert.equal(term.readCommand(), null)
  raw.buffer.active.type = 'normal'; term.noteInput('k'); term.noteInput('\x1b[D'); assert.equal(term.readCommand(), null)
})

test('wide-character wrap padding is omitted while actual spaces and continuation cells are preserved', () => {
  const line = (text, isWrapped = false) => {
    const cells = []
    for (const char of text) {
      const width = char === '中' ? 2 : 1
      cells.push({ chars: char, width, code: char.codePointAt(0) })
      if (width === 2) cells.push({ chars: '', width: 0, code: 0 })
    }
    while (cells.length < 20) cells.push({ chars: '', width: 1, code: 0 })
    return { isWrapped, getCell: index => ({ getWidth: () => cells[index].width, getCode: () => cells[index].code }), translateToString: (trim, start, end) => {
      const result = cells.slice(start, end).map(cell => cell.width ? cell.chars || ' ' : '').join('')
      return trim ? result.trimEnd() : result
    } }
  }
  for (const prefix of ['x'.repeat(10), 'x'.repeat(9) + ' ']) {
    const { term, raw } = terminalFixture()
    raw.cols = 20
    const lines = [line('fixture$ ' + prefix), line('中 | doc', true)]
    Object.assign(raw.buffer.active, { cursorY: 1, cursorX: 8, getLine: index => lines[index] })
    assert.equal(term.readCommand().text, prefix + '中 | doc')
    assert.equal(term.readCommand().cursor, prefix.length + '中 | doc'.length)
  }
})

test('combining and emoji grapheme backspace accepts only an exact echoed codepoint or grapheme deletion', () => {
  for (const suffix of ['e\u0301', '👩‍💻']) {
    const { term, raw } = terminalFixture()
    raw.setCommand('echo ' + suffix)
    term.noteInput('\x7f')
    term.write('unrelated output'); raw.setCommand('echo unexpected'); raw.flush()
    assert.equal(term.readCommand(), null)
    term.write('echo whole grapheme removed'); raw.setCommand('echo '); raw.flush()
    assert.equal(term.readCommand().text, 'echo ')
  }
  const { term, raw } = terminalFixture()
  raw.setCommand('echo e\u0301'); term.noteInput('\x7f'); term.noteInput('x')
  term.write('echo queued edit'); raw.setCommand('echo x'); raw.flush()
  assert.equal(term.readCommand().text, 'echo x')
})
