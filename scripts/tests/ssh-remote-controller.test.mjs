import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRemoteCompletion, mergeSuggestions } from '../../plugins/ssh/src/js/remoteCompletion.js'

const source = name => readFileSync(new URL(`../../plugins/ssh/src/js/${name}`, import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

/** Tiny DOM port: exercise the real controller lifecycle without a browser or build. */
function fixture() {
  class Element {
    constructor() { this.children = []; this.attrs = new Map(); this.dataset = {}; this.style = { setProperty() {} }; this.classList = { add() {}, remove() {} }; this.offsetHeight = 100 }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
    prepend(node) { node.parent = this; this.children.unshift(node) }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this) }
    setAttribute(key, value) { this.attrs.set(key, String(value)) }
    getAttribute(key) { return this.attrs.get(key) }
    removeAttribute(key) { this.attrs.delete(key) }
    addEventListener() {}
    contains(node) { return node === this || this.children.some(child => child.contains(node)) }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]) }
    querySelectorAll() { return this.descendants().filter(node => node.attrs.get('role') === 'option') }
    querySelector(selector) { return selector === 'textarea' ? this.input : this.descendants().find(node => node.dataset.index === selector.match(/data-index="(\d+)"/)?.[1]) }
    scrollIntoView() {}
    getBoundingClientRect() { return { top: 0, bottom: 450 } }
  }
  const document = { body: new Element(), createElement: () => new Element(), getElementById: () => null, addEventListener() {}, removeEventListener() {} }
  const window = { addEventListener() {}, removeEventListener() {} }
  new Function('window', source('dict.js'))(window)
  new Function('window', source('commandCompletion.js'))(window)
  new Function('window', 'document', 'navigator', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'cancelAnimationFrame', 'createRemoteCompletion', 'mergeSuggestions', source('sshCompletion.js').replace(/^import .+$/m, ''))(window, document, { platform: 'Linux' }, 800, 600, callback => setTimeout(callback, 0), clearTimeout, createRemoteCompletion, mergeSuggestions)
  let snapshot = { text: 'cat /tmp/re', cursor: 11, cwd: '/home/test', promptId: 1, revision: 1 }, release, reads = 0, cursorTop = 100, reveals = 0
  const writes = [], input = new Element(), terminal = new Element()
  terminal.input = input; terminal.append(input); document.activeElement = input
  const session = { tabId: 'a', sessionId: 'session-a', term: {
    el: terminal, focus() { document.activeElement = input }, readCommand: () => snapshot,
    cursorRect: () => ({ left: 20, top: cursorTop, cellHeight: 16 }), noteInput() {},
    revealCommand() {
      if (!snapshot) return false
      reveals++
      if (cursorTop > 450) {
        cursorTop = 100; snapshot = { ...snapshot, revision: snapshot.revision + 1 }
        controller.terminalState(session, { reason: 'scroll' })
      }
      return true
    }
  } }
  const controller = window.SshCompletion.create({
    getSession: () => session, getSources: () => ({ preferences: { remotePaths: true, remoteCommands: false } }),
    readDirectory: async () => { reads++; await new Promise(resolve => { release = resolve }); return [{ name: 'remote.txt', type: 'file' }] },
    send: async (_, data) => writes.push(data)
  })
  const escape = () => {
    const event = { type: 'keydown', key: 'Escape', prevented: false, preventDefault() { this.prevented = true } }
    const forwarded = controller.keydown(event, session)
    if (forwarded) { writes.push('\x1b'); snapshot = null }
    return { forwarded, prevented: event.prevented }
  }
  return { controller, escape, writes, setSnapshot: value => { snapshot = value }, getSnapshot: () => snapshot, setCursorTop: value => { cursorTop = value }, reveals: () => reveals, reads: () => reads, release: () => release(), boxes: () => document.body.children.length }
}

test('Escape owns a loading list, preserves the prompt and permits explicit reopen after a late result', async () => {
  const f = fixture()
  f.controller.run(true); await tick(); assert.equal(f.reads(), 1)
  assert.deepEqual(f.escape(), { forwarded: false, prevented: true }); assert.equal(f.boxes(), 0)
  assert.equal(f.getSnapshot().text, 'cat /tmp/re'); assert.deepEqual(f.writes, [])
  f.release(); await tick(); assert.equal(f.boxes(), 0)
  f.controller.run(true); await tick(); assert.equal(f.controller.isOpen(), true)
  await f.controller.accept(); assert.deepEqual(f.writes, ['mote.txt'])
  assert.deepEqual(f.escape(), { forwarded: true, prevented: false })
  assert.equal(f.writes.at(-1), '\x1b'); f.controller.dispose()
})

test('a prompt revision changed before dispatch cancels the actual read even without a UI event', async () => {
  const f = fixture()
  f.controller.run(true)
  f.setSnapshot({ ...f.getSnapshot(), revision: 2 })
  await tick(); assert.equal(f.reads(), 0); assert.equal(f.boxes(), 0)
  f.controller.dispose()
})

test('a silent cwd change while reading drops the result and closes the stale loading list', async () => {
  const f = fixture()
  f.controller.run(true); await tick(); assert.equal(f.reads(), 1)
  f.setSnapshot({ ...f.getSnapshot(), cwd: '/another' }); f.release(); await tick()
  assert.equal(f.controller.isOpen(), false); assert.equal(f.boxes(), 0); assert.deepEqual(f.writes, [])
  f.controller.dispose()
})

test('known subcommands and enum values keep their slot while explicit paths still read SFTP', async () => {
  const f = fixture()
  for (const text of ['docker ', 'docker co', 'docker compose ', 'curl -X P']) {
    f.setSnapshot({ ...f.getSnapshot(), text, cursor: text.length })
    f.controller.run(true); await tick()
    assert.equal(f.controller.isOpen(), true, text)
    assert.equal(f.reads(), 0, `${text} must not read unrelated directory entries`)
  }
  const text = 'docker /tmp/re'
  f.setSnapshot({ ...f.getSnapshot(), text, cursor: text.length })
  f.controller.run(true); await tick()
  assert.equal(f.reads(), 1, 'an explicit path without a matching subcommand still reads SFTP')
  f.release(); await tick()
  assert.equal(f.controller.isOpen(), true)
  await f.controller.accept()
  assert.deepEqual(f.writes, ['mote.txt'])
  f.controller.dispose()
})

test('explicit completion reveals the trusted prompt and recaptures its revision; automatic completion never scrolls', async () => {
  const f = fixture(), text = 'docker '
  f.setSnapshot({ ...f.getSnapshot(), text, cursor: text.length })
  f.setCursorTop(520)
  f.controller.run(false)
  assert.equal(f.reveals(), 0)
  assert.equal(f.boxes(), 0)
  const revision = f.getSnapshot().revision
  f.controller.run(true)
  assert.equal(f.reveals(), 1)
  assert.equal(f.getSnapshot().revision, revision + 1)
  assert.equal(f.boxes(), 1)
  await f.controller.accept()
  assert.deepEqual(f.writes, ['ps'], 'acceptance uses the post-scroll revision without sending Enter')
  f.controller.dispose()
})
